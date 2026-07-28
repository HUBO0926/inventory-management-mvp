import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ApprovalContext, ApprovalHistoryService } from '../audit/approval-history.service';
import { BusinessException } from '../common/business.exception';
import { Direction, DocumentType, ItemType } from '../common/constants';
import { parsePage } from '../common/validation';
import { InventoryPostingService } from '../inventory/posting.service';
import { StockReservationService } from '../inventory/reservation.service';

@Injectable()
export class StockDocumentsService {
  constructor(private readonly db: DataSource, private readonly posting: InventoryPostingService, private readonly audit: AuditService, private readonly approvalHistory: ApprovalHistoryService, private readonly reservations: StockReservationService) {}

  async create(type: DocumentType, dto: any, userId: string) {
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const expectedType = type === DocumentType.MATERIAL_INBOUND ? 'RAW' : type === DocumentType.FINISHED_OUTBOUND || type === DocumentType.FINISHED_INBOUND ? 'FG' : undefined;
      const [warehouse] = dto.warehouseId
        ? await qr.query(`SELECT id,warehouse_type FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [dto.warehouseId])
        : await qr.query(`SELECT id,warehouse_type FROM warehouses WHERE warehouse_type=$1 AND status='ACTIVE' AND deleted_at IS NULL ORDER BY warehouse_code LIMIT 1`, [expectedType]);
      if (!warehouse || (expectedType && warehouse.warehouse_type !== expectedType)) throw new BusinessException('VALIDATION_ERROR', '仓库不存在、已停用或类型不符合单据要求');
      const lines = await this.fillDefaultLocations(qr, dto.lines, warehouse.id);
      await this.validateManualLines(qr, type, lines, warehouse.id);
      const direction = [DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND].includes(type) ? Direction.IN : Direction.OUT;
      const doc = await this.posting.createDocument(qr, { documentType: type, warehouseId: warehouse.id, notes: dto.notes, lines: lines.map((line: any) => ({ ...line, direction: type === DocumentType.INVENTORY_ADJUSTMENT ? line.direction : direction })) }, userId);
      await this.audit.log(userId, 'CREATE_STOCK_DOCUMENT', 'stock_documents', doc.id, { type }, qr.manager);
      await qr.commitTransaction(); return this.get(doc.id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async createMove(dto: any, userId: string) {
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const [source] = await qr.query(`SELECT id FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [dto.warehouseId]);
      if (!source) throw new BusinessException('VALIDATION_ERROR', '来源仓库不存在或已停用');
      if (!Array.isArray(dto.lines) || !dto.lines.length) throw new BusinessException('VALIDATION_ERROR', '移库单至少包含一条明细');
      for (const line of dto.lines) {
        if (!line.targetWarehouseId || !line.targetLocationId) throw new BusinessException('VALIDATION_ERROR', '请完整选择移库目标仓库和库位');
        if (line.targetWarehouseId === dto.warehouseId && line.targetLocationId === line.locationId) throw new BusinessException('VALIDATION_ERROR', '移库来源和目标不能相同');
      }
      await this.validateMoveLines(qr, dto.lines, dto.warehouseId);
      const doc = await this.posting.createDocument(qr, { documentType: DocumentType.STOCK_MOVE, warehouseId: dto.warehouseId, notes: dto.notes, lines: dto.lines.map((line: any) => ({ ...line, direction: Direction.OUT })) }, userId);
      await this.audit.log(userId, 'CREATE_STOCK_MOVE', 'stock_documents', doc.id, undefined, qr.manager);
      await qr.commitTransaction(); return this.get(doc.id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async update(id: string, dto: any, userId: string) {
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const [doc] = await qr.query(`SELECT * FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      if (!['DRAFT', 'REJECTED', 'SUBMITTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS', '只有草稿、待审核或已驳回单据可以编辑');
      if (doc.status === 'SUBMITTED') {
        await this.reservations.releaseDocument(qr, id);
        await this.approvalHistory.record(qr,id,'WITHDRAWN','SUBMITTED','DRAFT',userId,{ reason:'编辑待审核单据自动撤回' });
      }
      if (![DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND, DocumentType.FINISHED_OUTBOUND, DocumentType.STOCK_MOVE].includes(doc.document_type)) throw new BusinessException('INVALID_STATUS', '该单据不能在此编辑');
      const lines = doc.document_type === DocumentType.STOCK_MOVE
        ? dto.lines : await this.fillDefaultLocations(qr, dto.lines, doc.warehouse_id);
      if (doc.document_type === DocumentType.STOCK_MOVE) await this.validateMoveLines(qr, lines, doc.warehouse_id);
      else await this.validateManualLines(qr, doc.document_type, lines, doc.warehouse_id);
      const direction = [DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND].includes(doc.document_type) ? Direction.IN : Direction.OUT;
      await qr.query(`UPDATE stock_documents SET notes=$1,status='DRAFT',submitted_by=NULL,submitted_at=NULL,rejection_reason=NULL,updated_at=now() WHERE id=$2`, [dto.notes || null, id]);
      await qr.query(`DELETE FROM stock_document_lines WHERE document_id=$1`, [id]);
      for (const line of lines) await this.insertLine(qr, id, doc.warehouse_id, { ...line, direction });
      await this.audit.log(userId, 'UPDATE_STOCK_DOCUMENT', 'stock_documents', id, undefined, qr.manager);
      await qr.commitTransaction(); return this.get(id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async remove(id: string, userId: string) {
    return this.cancel(id, userId);
  }

  async cancel(id: string, userId: string) {
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const [doc] = await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      if (!['DRAFT', 'REJECTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS', '只有草稿或已驳回单据可以取消');
      await this.reservations.releaseDocument(qr, id);
      await qr.query(`UPDATE stock_documents SET status='CANCELLED',updated_at=now() WHERE id=$1`, [id]);
      await this.approvalHistory.record(qr, id, 'CANCELLED', doc.status, 'CANCELLED', userId, { reason:'用户取消单据' });
      await this.audit.log(userId, 'CANCEL_STOCK_DOCUMENT', 'stock_documents', id, undefined, qr.manager);
      await qr.commitTransaction();
      return this.get(id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  post(id: string, key: string | undefined, userId: string) { return this.posting.executeIdempotent(userId, key, 'POST:/stock-documents/:id/post', { id }, qr => this.applyAndFinalize(qr, id, userId, ['DRAFT', 'SUBMITTED'])); }
  async submit(id: string, userId: string, context: ApprovalContext = {}) {
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try { const [doc] = await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]); if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在'); if (doc.status==='SUBMITTED') { await qr.commitTransaction(); return this.get(id); } if (!['DRAFT','REJECTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS', '只有草稿或已驳回单据可以提交');
      await this.reservations.reserveDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='SUBMITTED',submitted_by=$1,submitted_at=now(),updated_at=now() WHERE id=$2`, [userId,id]);
      await this.approvalHistory.record(qr,id,'SUBMITTED',doc.status,'SUBMITTED',userId,context); await this.audit.log(userId,'SUBMIT_STOCK_DOCUMENT','stock_documents',id,undefined,qr.manager); await qr.commitTransaction(); return this.get(id);
    } catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
  }
  async withdraw(id: string, userId: string, context: ApprovalContext = {}) {
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try { const [doc] = await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]); if (!doc || doc.status !== 'SUBMITTED') throw new BusinessException('INVALID_STATUS', '只有待审核单据可以撤回');
      await this.reservations.releaseDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='DRAFT',submitted_by=NULL,submitted_at=NULL,updated_at=now() WHERE id=$1`, [id]);
      await this.approvalHistory.record(qr,id,'WITHDRAWN','SUBMITTED','DRAFT',userId,context); await this.audit.log(userId,'WITHDRAW_STOCK_DOCUMENT','stock_documents',id,undefined,qr.manager); await qr.commitTransaction(); return this.get(id);
    } catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
  }

  approve(id: string, dto: any, key: string | undefined, userId: string, context: ApprovalContext = {}) {
    return this.posting.executeIdempotent(userId, key, 'POST:/stock-documents/:id/approve', { id, receiptAllocations: dto?.receiptAllocations || null }, async qr => {
      const [doc] = await qr.query(`SELECT document_type,status FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      if ([DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND].includes(doc.document_type)) await this.saveReceiptAllocations(qr, id, dto?.receiptAllocations);
      const result = await this.applyAndFinalize(qr, id, userId, ['SUBMITTED']);
      await this.approvalHistory.record(qr,id,'APPROVED','SUBMITTED','POSTED',userId,{ ...context, idempotencyKey:key }); return result;
    });
  }

  async reject(id: string, reason: string | undefined, userId: string, context: ApprovalContext = {}) {
    if (!reason?.trim()) throw new BusinessException('VALIDATION_ERROR', '请填写驳回原因');
    const execute = async (qr: QueryRunner) => { const [doc] = await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`,[id]); if (!doc || doc.status !== 'SUBMITTED') throw new BusinessException('INVALID_STATUS','只有待审核单据可以驳回');
      await this.reservations.releaseDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='REJECTED',rejected_by=$1,rejected_at=now(),rejection_reason=$2,updated_at=now() WHERE id=$3`,[userId,reason,id]);
      await this.approvalHistory.record(qr,id,'REJECTED','SUBMITTED','REJECTED',userId,{...context,reason}); await this.audit.log(userId,'REJECT_STOCK_DOCUMENT','stock_documents',id,{reason},qr.manager); return this.get(id); };
    if (context.idempotencyKey) return this.posting.executeIdempotent(userId,context.idempotencyKey,'POST:/approvals/:id/reject',{id,reason,reasonCode:context.reasonCode||null},execute);
    const qr=this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction(); try { const result=await execute(qr); await qr.commitTransaction(); return result; } catch(e){await qr.rollbackTransaction();throw e;} finally {await qr.release();}
  }

  void(id: string, reason: string | undefined, key: string | undefined, userId: string) {
    return this.posting.executeIdempotent(userId, key, 'POST:/stock-documents/:id/void', { id, reason: reason || null }, async qr => {
      const [original] = await qr.query(`SELECT * FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!original) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      if (original.status !== 'POSTED' || original.document_type === DocumentType.REVERSAL) throw new BusinessException('INVALID_STATUS', '只有已过账的非冲销单据可以冲销');
      const transactions = await qr.query(`SELECT t.warehouse_id,t.location_id,t.item_id,t.batch_id,abs(t.delta_qty)::text quantity,CASE WHEN t.delta_qty>0 THEN 'OUT' ELSE 'IN' END direction FROM stock_transactions t WHERE t.source_document_id=$1 ORDER BY t.warehouse_id,t.location_id,t.item_id`, [id]);
      const reversal = await this.posting.createDocument(qr, { documentType: DocumentType.REVERSAL, warehouseId: original.warehouse_id, productionOrderId: original.production_order_id, originalDocumentId: id, notes: reason || `冲销 ${original.document_no}`, lines: transactions.map((line: any) => ({ itemId: line.item_id, quantity: line.quantity, locationId: line.location_id, targetWarehouseId: line.warehouse_id, batchId: line.batch_id, direction: line.direction })) }, userId);
      const posted = await this.posting.applyDocument(qr, reversal.id, userId, ['DRAFT']);
      await qr.query(`UPDATE stock_documents SET status='VOIDED',voided_by=$1,voided_at=now(),updated_at=now() WHERE id=$2`, [userId, id]);
      if (original.production_order_id) await this.reverseProduction(qr, original);
      await this.audit.log(userId, 'VOID_STOCK_DOCUMENT', 'stock_documents', id, { reversalId: reversal.id, reason }, qr.manager); return { ...posted, originalDocumentId: id };
    });
  }

  async createAdjustment(dto: any, userId: string) { const lines = dto.lines.map((line: any) => { const value = new Decimal(line.adjustmentQty); if (!value.isFinite() || value.isZero() || value.decimalPlaces() > 4) throw new BusinessException('VALIDATION_ERROR', '调整数量必须是非零且最多四位小数'); return { ...line, quantity: value.abs().toFixed(4), direction: value.isPositive() ? Direction.IN : Direction.OUT }; }); return this.create(DocumentType.INVENTORY_ADJUSTMENT, { ...dto, lines }, userId); }

  private async saveReceiptAllocations(qr: QueryRunner, documentId: string, allocations: any[]) {
    const lines = await qr.query(`SELECT id,item_id,quantity,location_id,batch_id FROM stock_document_lines WHERE document_id=$1 ORDER BY id`, [documentId]);
    if (!Array.isArray(allocations) || !allocations.length) throw new BusinessException('VALIDATION_ERROR', '入库审核必须填写正常品或不良品入库分配');
    const allowed = new Set(lines.map((line: any) => line.id));
    if (allocations.some(row => !allowed.has(row.documentLineId))) throw new BusinessException('VALIDATION_ERROR', '审核分配包含不属于该单据的明细');
    await qr.query(`DELETE FROM stock_document_receipt_allocations WHERE document_line_id=ANY($1::uuid[])`, [lines.map((line: any) => line.id)]);
    for (const line of lines) {
      const rows = allocations.filter(row => row.documentLineId === line.id);
      const total = rows.reduce((sum: Decimal, row: any) => sum.add(row.quantity || 0), new Decimal(0));
      if (!rows.length || !total.eq(line.quantity)) throw new BusinessException('VALIDATION_ERROR', '每条入库明细的正常品与不良品数量之和必须等于送审数量');
      for (const row of rows) {
        if (!['NORMAL', 'DEFECTIVE'].includes(row.disposition) || !new Decimal(row.quantity || 0).isPositive() || !row.warehouseId || !row.locationId) throw new BusinessException('VALIDATION_ERROR', '入库审核分配不完整');
        await qr.query(`INSERT INTO stock_document_receipt_allocations(id,document_line_id,disposition,warehouse_id,location_id,batch_id,quantity) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6)`, [line.id, row.disposition, row.warehouseId, row.locationId, row.batchId || line.batch_id || null, new Decimal(row.quantity).toFixed(4)]);
      }
    }
  }

  private async applyAndFinalize(qr: QueryRunner, id: string, userId: string, allowedStatuses: string[]) {
    const [doc] = await qr.query(`SELECT document_type,production_order_id FROM stock_documents WHERE id=$1`, [id]);
    if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
    if (!doc.production_order_id) return this.posting.applyDocument(qr, id, userId, allowedStatuses);
    const [order] = await qr.query(`SELECT * FROM production_orders WHERE id=$1 FOR UPDATE`, [doc.production_order_id]);
    if (!order || !['RELEASED', 'IN_PROGRESS'].includes(order.status)) throw new BusinessException('INVALID_STATUS', '生产任务已完成或取消，不能审核该单据');
    const lines = await qr.query(`SELECT item_id,sum(quantity)::numeric(18,4) quantity,sum(normal_qty)::numeric(18,4) normal_qty,sum(spare_qty)::numeric(18,4) spare_qty FROM stock_document_lines WHERE document_id=$1 GROUP BY item_id`, [id]);
    const materials = await qr.query(`SELECT * FROM production_order_materials WHERE production_order_id=$1 FOR UPDATE`, [doc.production_order_id]);
    if ([DocumentType.PRODUCTION_ISSUE, DocumentType.PRODUCTION_RETURN].includes(doc.document_type)) for (const line of lines) {
      const material = materials.find((row: any) => row.material_id === line.item_id); if (!material) throw new BusinessException('VALIDATION_ERROR', '单据物料不属于生产任务 BOM');
      const net = new Decimal(material.issued_qty).sub(material.returned_qty);
      if (doc.document_type === DocumentType.PRODUCTION_ISSUE && net.add(line.normal_qty || line.quantity).gt(material.required_qty)) throw new BusinessException('VALIDATION_ERROR', '审核后正常净领料将超过 BOM 需求量');
      if (doc.document_type === DocumentType.PRODUCTION_ISSUE && new Decimal(material.spare_issued_qty || 0).add(line.spare_qty || 0).gt(new Decimal(material.required_qty).mul('0.1'))) throw new BusinessException('VALIDATION_ERROR', '审核后备用件累计将超过 BOM 需求量的 10%');
      if (doc.document_type === DocumentType.PRODUCTION_RETURN && new Decimal(line.quantity).gt(net)) throw new BusinessException('VALIDATION_ERROR', '审核后退料量将超过当前净领料量');
    }
    const total = lines.reduce((sum: Decimal, line: any) => sum.add(line.quantity), new Decimal(0));
    if (doc.document_type === DocumentType.PRODUCTION_COMPLETION && new Decimal(order.completed_qty).add(total).gt(order.planned_qty)) throw new BusinessException('VALIDATION_ERROR', '审核后累计完工将超过计划数量');
    const result = await this.posting.applyDocument(qr, id, userId, allowedStatuses);
    if (doc.document_type === DocumentType.PRODUCTION_ISSUE) {
      for (const line of lines) await qr.query(`UPDATE production_order_materials SET issued_qty=issued_qty+$1,spare_issued_qty=spare_issued_qty+$2 WHERE production_order_id=$3 AND material_id=$4`, [line.normal_qty || line.quantity,line.spare_qty || 0,doc.production_order_id,line.item_id]);
      await qr.query(`UPDATE production_orders SET status='IN_PROGRESS',updated_at=now() WHERE id=$1`, [doc.production_order_id]);
    }
    if (doc.document_type === DocumentType.PRODUCTION_RETURN) {
      for (const line of lines) await qr.query(`UPDATE production_order_materials SET returned_qty=returned_qty+$1 WHERE production_order_id=$2 AND material_id=$3`, [line.quantity,doc.production_order_id,line.item_id]);
      await qr.query(`UPDATE production_orders SET status='IN_PROGRESS',updated_at=now() WHERE id=$1`, [doc.production_order_id]);
    }
    if (doc.document_type === DocumentType.PRODUCTION_COMPLETION) { const completed = new Decimal(order.completed_qty).add(total); const status = completed.eq(order.planned_qty) ? 'COMPLETED' : 'IN_PROGRESS'; await qr.query(`UPDATE production_orders SET completed_qty=$1,status=$2,updated_at=now() WHERE id=$3`, [completed.toFixed(4), status, doc.production_order_id]); return { ...result, productionStatus: status, completedQty: completed.toFixed(4) }; }
    return result;
  }

  private async reverseProduction(qr: QueryRunner, doc: any) { const lines = await qr.query(`SELECT item_id,sum(quantity)::numeric(18,4) quantity,sum(normal_qty)::numeric(18,4) normal_qty,sum(spare_qty)::numeric(18,4) spare_qty FROM stock_document_lines WHERE document_id=$1 GROUP BY item_id`, [doc.id]); if (doc.document_type === DocumentType.PRODUCTION_ISSUE) { for (const line of lines) await qr.query(`UPDATE production_order_materials SET issued_qty=issued_qty-$1,spare_issued_qty=spare_issued_qty-$2 WHERE production_order_id=$3 AND material_id=$4`, [line.normal_qty || line.quantity,line.spare_qty || 0,doc.production_order_id,line.item_id]); } if (doc.document_type === DocumentType.PRODUCTION_RETURN) { for (const line of lines) await qr.query(`UPDATE production_order_materials SET returned_qty=returned_qty-$1 WHERE production_order_id=$2 AND material_id=$3`, [line.quantity,doc.production_order_id,line.item_id]); } if (doc.document_type === DocumentType.PRODUCTION_COMPLETION) await qr.query(`UPDATE production_orders SET completed_qty=completed_qty-$1 WHERE id=$2`, [lines.reduce((sum: Decimal, line: any) => sum.add(line.quantity), new Decimal(0)).toFixed(4), doc.production_order_id]); }

  private async fillDefaultLocations(qr: QueryRunner, lines: any[], warehouseId: string) {
    if (!Array.isArray(lines) || lines.every(line => line.locationId)) return lines;
    const [location] = await qr.query(`SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND status='ACTIVE' AND is_archived=false ORDER BY auto_generated DESC,sort_order NULLS LAST,code LIMIT 1`, [warehouseId]);
    if (!location) throw new BusinessException('VALIDATION_ERROR', '仓库没有可用库位');
    return lines.map(line => line.locationId ? line : { ...line, locationId: location.id });
  }

  private async insertLine(qr: QueryRunner, documentId: string, warehouseId: string, line: any) { const locationId = line.locationId; if (!locationId) throw new BusinessException('VALIDATION_ERROR', '仓库没有可用库位'); await qr.query(`INSERT INTO stock_document_lines(id,document_id,item_id,quantity,direction,location_id,batch_id,target_warehouse_id,target_location_id,target_batch_id,notes) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [documentId, line.itemId, line.quantity, line.direction, locationId, line.batchId || null, line.targetWarehouseId || null, line.targetLocationId || null, line.targetBatchId || null, line.notes || null]); }

  private async validateManualLines(qr: QueryRunner, type: DocumentType, lines: any[], warehouseId: string) { if (!Array.isArray(lines) || !lines.length) throw new BusinessException('VALIDATION_ERROR', '单据至少包含一条明细'); const ids = lines.map(line => line.itemId); const items = await qr.query(`SELECT id,item_type,status FROM items WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]); if (items.length !== ids.length || items.some((item: any) => item.status !== 'ACTIVE')) throw new BusinessException('VALIDATION_ERROR', '单据只能包含启用物料'); if (type !== DocumentType.INVENTORY_ADJUSTMENT) { const expected = type === DocumentType.MATERIAL_INBOUND ? ItemType.MATERIAL : ItemType.FINISHED_GOOD; if (items.some((item: any) => item.item_type !== expected)) throw new BusinessException('VALIDATION_ERROR', expected === ItemType.MATERIAL ? '原材料入库只能包含原材料' : '成品入库或出库只能包含成品'); } await this.validateLocations(qr, lines, warehouseId, false); }
  private async validateMoveLines(qr: QueryRunner, lines: any[], warehouseId: string) { await this.validateManualLines(qr, DocumentType.INVENTORY_ADJUSTMENT, lines, warehouseId); await this.validateLocations(qr, lines, warehouseId, true); }
  private async validateLocations(qr: QueryRunner, lines: any[], warehouseId: string, moving: boolean) { for (const line of lines) { const [source] = await qr.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND status='ACTIVE'`, [line.locationId, warehouseId]); if (!source) throw new BusinessException('VALIDATION_ERROR', '来源库位不存在、已停用或不属于当前仓库'); if (moving) { const [target] = await qr.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND status='ACTIVE'`, [line.targetLocationId, line.targetWarehouseId]); if (!target) throw new BusinessException('VALIDATION_ERROR', '移库目标库位不存在、已停用或不属于目标仓库'); } } }

  async get(id: string) {
    const [doc] = await this.db.query(`
      SELECT d.id,d.document_no "documentNo",d.document_type "documentType",d.status,d.notes,
        d.rejection_reason "rejectionReason",d.production_order_id "productionOrderId",po.order_no "productionOrderNo",
        d.original_document_id "originalDocumentId",original.document_no "originalDocumentNo",
        w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
        COALESCE(d.created_by_name,u.name,d.created_by_username,u.username,'—') "createdByName",
        COALESCE(d.submitted_by_name,d.submitted_by_username,'—') "submittedByName",
        COALESCE(d.approved_by_name,d.approved_by_username,'—') "approvedByName",
        COALESCE(d.posted_by_name,d.posted_by_username,'—') "postedByName",
        COALESCE(d.voided_by_name,d.voided_by_username,'—') "voidedByName",
        d.created_at "createdAt",d.submitted_at "submittedAt",d.approved_at "approvedAt",
        d.posted_at "postedAt",d.voided_at "voidedAt"
      FROM stock_documents d
      JOIN warehouses w ON w.id=d.warehouse_id
      LEFT JOIN users u ON u.id=d.created_by
      LEFT JOIN production_orders po ON po.id=d.production_order_id
      LEFT JOIN stock_documents original ON original.id=d.original_document_id
      WHERE d.id=$1`, [id]);
    if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
    doc.sourceBusiness = doc.productionOrderId ? '生产任务' : doc.documentType === DocumentType.REVERSAL ? '单据冲销' : '库存作业';
    doc.sourceDocumentNo = doc.productionOrderNo || doc.originalDocumentNo || null;
    doc.lines = await this.db.query(`
      SELECT l.id,l.item_id "itemId",i.item_code "itemCode",i.name "itemName",i.model,i.spec,
        COALESCE(parameters.value,'—') parameters,i.unit,l.quantity,l.direction,l.notes,
        COALESCE(l.source_warehouse_id,d.warehouse_id) "sourceWarehouseId",sw.warehouse_code "sourceWarehouseCode",
        sz.code "sourceZoneCode",l.location_id "locationId",loc.code "locationCode",
        l.batch_id "batchId",b.batch_no "batchNo",l.target_warehouse_id "targetWarehouseId",
        tw.warehouse_code "targetWarehouseCode",tz.code "targetZoneCode",
        l.target_location_id "targetLocationId",tl.code "targetLocationCode",
        l.target_batch_id "targetBatchId",po.order_no "productionOrderNo"
      FROM stock_document_lines l
      JOIN stock_documents d ON d.id=l.document_id
      JOIN items i ON i.id=l.item_id
      JOIN warehouse_locations loc ON loc.id=l.location_id
      JOIN warehouse_zones sz ON sz.id=loc.zone_id
      JOIN warehouses sw ON sw.id=COALESCE(l.source_warehouse_id,d.warehouse_id)
      LEFT JOIN inventory_batches b ON b.id=l.batch_id
      LEFT JOIN warehouses tw ON tw.id=l.target_warehouse_id
      LEFT JOIN warehouse_locations tl ON tl.id=l.target_location_id
      LEFT JOIN warehouse_zones tz ON tz.id=tl.zone_id
      LEFT JOIN production_orders po ON po.id=d.production_order_id
      LEFT JOIN LATERAL (
        SELECT string_agg(parameter_name||'：'||parameter_value||COALESCE(' '||unit,''),'；' ORDER BY sort_order) value
        FROM material_parameters WHERE material_id=i.id
      ) parameters ON true
      WHERE l.document_id=$1 ORDER BY i.item_code,loc.code`, [id]);
    doc.receiptAllocations = await this.db.query(`SELECT a.document_line_id "documentLineId",a.disposition,a.warehouse_id "warehouseId",w.warehouse_code "warehouseCode",a.location_id "locationId",l.code "locationCode",a.batch_id "batchId",a.quantity FROM stock_document_receipt_allocations a JOIN stock_document_lines dl ON dl.id=a.document_line_id JOIN warehouses w ON w.id=a.warehouse_id JOIN warehouse_locations l ON l.id=a.location_id WHERE dl.document_id=$1 ORDER BY a.id`, [id]);
    doc.operationRecords = await this.db.query(`
      SELECT action,COALESCE(actor_name,actor_username,'—') "actorName",created_at "createdAt",
        CASE WHEN status_after='REJECTED' THEN '驳回' ELSE '成功' END result,
        COALESCE(reason,CASE action WHEN 'SUBMITTED' THEN '提交审核' WHEN 'APPROVED' THEN '审核通过并过账'
          WHEN 'WITHDRAWN' THEN '撤回单据' WHEN 'CANCELLED' THEN '取消单据' ELSE action END) description
      FROM approval_records WHERE document_id=$1
      UNION ALL
      SELECT 'CREATED',COALESCE(d.created_by_name,u.name,d.created_by_username,u.username,'—'),d.created_at,'成功','创建单据'
      FROM stock_documents d LEFT JOIN users u ON u.id=d.created_by WHERE d.id=$1
      UNION ALL
      SELECT 'VOIDED',COALESCE(d.voided_by_name,d.voided_by_username,'—'),d.voided_at,'成功',COALESCE(d.notes,'冲销单据')
      FROM stock_documents d WHERE d.id=$1 AND d.voided_at IS NOT NULL
      ORDER BY "createdAt" DESC`, [id]);
    doc.transactions = await this.db.query(`
      SELECT t.id "transactionNo",t.id,t.delta_qty "deltaQty",t.balance_before "balanceBefore",
        t.balance_after "balanceAfter",i.item_code "itemCode",i.name "itemName",
        w.warehouse_code "warehouseCode",z.code "zoneCode",loc.code "locationCode",
        batch.batch_no "batchNo",COALESCE(t.operator_name,t.operator_username,u.name,u.username,'—') operator,
        t.created_at "createdAt"
      FROM stock_transactions t
      JOIN items i ON i.id=t.item_id JOIN warehouses w ON w.id=t.warehouse_id
      JOIN warehouse_locations loc ON loc.id=t.location_id JOIN warehouse_zones z ON z.id=loc.zone_id
      LEFT JOIN inventory_batches batch ON batch.id=t.batch_id LEFT JOIN users u ON u.id=t.created_by
      WHERE t.source_document_id=$1 ORDER BY t.created_at DESC`, [id]);
    return doc;
  }

  async list(q: any) {
    const page = parsePage(q.page, 1), pageSize = parsePage(q.pageSize, 20, 100), offset = (page - 1) * pageSize;
    const params: any[] = [], where: string[] = [];
    const add = (value: any, expression: string) => { if (value === undefined || value === '') return; params.push(value); where.push(expression.replace('?', `$${params.length}`)); };
    if (q.keyword) { params.push(`%${q.keyword}%`); where.push(`(d.document_no ILIKE $${params.length} OR d.notes ILIKE $${params.length} OR po.order_no ILIKE $${params.length})`); }
    if (q.createdByKeyword) {
      params.push(`%${q.createdByKeyword}%`);
      where.push(`(COALESCE(d.created_by_name,'') ILIKE $${params.length} OR COALESCE(d.created_by_username,'') ILIKE $${params.length})`);
    }
    if (q.documentType === 'DEFECTIVE_INBOUND') where.push(`EXISTS(SELECT 1 FROM stock_document_lines dl JOIN stock_document_receipt_allocations a ON a.document_line_id=dl.id WHERE dl.document_id=d.id AND a.disposition='DEFECTIVE')`);
    else add(q.documentType, 'd.document_type=?');
    add(q.status, 'd.status=?'); add(q.warehouseId, 'd.warehouse_id=?'); add(q.createdBy, 'd.created_by=?');
    add(q.createdFrom, 'd.created_at>=?::date'); add(q.createdTo, `d.created_at<(?::date+interval '1 day')`);
    add(q.postedFrom, 'd.posted_at>=?::date'); add(q.postedTo, `d.posted_at<(?::date+interval '1 day')`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortColumns: Record<string,string> = { documentNo:'d.document_no',documentType:'d.document_type',status:'d.status',createdAt:'d.created_at',postedAt:'d.posted_at' };
    const sort = sortColumns[q.sortField] || 'd.created_at'; const order = String(q.sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const [{ count }] = await this.db.query(`SELECT count(*)::int count FROM stock_documents d LEFT JOIN production_orders po ON po.id=d.production_order_id ${clause}`, params);
    params.push(pageSize, offset);
    const items = await this.db.query(`
      SELECT d.id,d.document_no "documentNo",d.document_type "documentType",d.status,d.notes,
        w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
        po.order_no "productionOrderNo",original.document_no "originalDocumentNo",
        CASE WHEN d.production_order_id IS NOT NULL THEN '生产任务' WHEN d.document_type='REVERSAL' THEN '单据冲销' ELSE '库存作业' END "sourceBusiness",
        COALESCE(po.order_no,original.document_no) "sourceDocumentNo",
        COALESCE(d.created_by_name,u.name,d.created_by_username,u.username,'—') "createdByName",
        COALESCE(d.posted_by_name,d.posted_by_username,'—') "postedByName",
        d.created_at "createdAt",d.posted_at "postedAt"
      FROM stock_documents d JOIN warehouses w ON w.id=d.warehouse_id
      LEFT JOIN users u ON u.id=d.created_by LEFT JOIN production_orders po ON po.id=d.production_order_id
      LEFT JOIN stock_documents original ON original.id=d.original_document_id
      ${clause} ORDER BY ${sort} ${order},d.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items, total: count, page, pageSize };
  }

  async exportCsv(q: any) {
    const first = await this.list({ ...q, page:1, pageSize:100 }); const rows = [...first.items];
    for (let page=2; page<=Math.ceil(first.total/100); page++) rows.push(...(await this.list({ ...q, page, pageSize:100 })).items);
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g,'""')}"`;
    return '\uFEFF'+[
      ['单号','类型','状态','来源业务','来源单号','仓库','创建人','创建时间','过账人','过账时间'],
      ...rows.map((row:any)=>[row.documentNo,row.documentType,row.status,row.sourceBusiness,row.sourceDocumentNo,row.warehouseCode,row.createdByName,row.createdAt,row.postedByName,row.postedAt]),
    ].map(row=>row.map(escape).join(',')).join('\r\n');
  }
}
