import { Injectable, Optional } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ApprovalContext, ApprovalHistoryService } from '../audit/approval-history.service';
import { BusinessException } from '../common/business.exception';
import { AuthUser, Direction, DocumentType, ItemType } from '../common/constants';
import { parsePage } from '../common/validation';
import { InventoryPostingService } from '../inventory/posting.service';
import { StockReservationService } from '../inventory/reservation.service';
import { ApprovalWorkflowService } from '../approvals/approval-workflow.service';
import { WarehouseAccessService } from '../warehouses/warehouse-access.service';
import { WarehouseManagementService } from '../warehouses/warehouse-management.service';

@Injectable()
export class StockDocumentsService {
  constructor(private readonly db: DataSource, private readonly posting: InventoryPostingService, private readonly audit: AuditService, private readonly approvalHistory: ApprovalHistoryService, private readonly reservations: StockReservationService, private readonly workflow: ApprovalWorkflowService, private readonly warehouseAccess: WarehouseAccessService, @Optional() private readonly operations?: WarehouseManagementService) {}

  async create(type: DocumentType, dto: any, user: AuthUser) {
    const userId = user.id;
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const expectedType = type === DocumentType.MATERIAL_INBOUND ? 'RAW' : type === DocumentType.FINISHED_OUTBOUND || type === DocumentType.FINISHED_INBOUND ? 'FG' : undefined;
      const [warehouse] = dto.warehouseId
        ? await qr.query(`SELECT id,warehouse_type FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [dto.warehouseId])
        : await qr.query(`SELECT id,warehouse_type FROM warehouses WHERE warehouse_type=$1 AND status='ACTIVE' AND deleted_at IS NULL ORDER BY warehouse_code LIMIT 1`, [expectedType]);
      if (!warehouse || (expectedType && warehouse.warehouse_type !== expectedType)) throw new BusinessException('VALIDATION_ERROR', '仓库不存在、已停用或类型不符合单据要求');
      await this.warehouseAccess.assertWarehouse(user, warehouse.id);
      const lines = await this.fillDefaultLocations(qr, dto.lines, warehouse.id);
      await this.validateManualLines(qr, type, lines, warehouse.id);
      if (type === DocumentType.INVENTORY_ADJUSTMENT) await this.validateAdjustmentLines(qr, lines, warehouse.id);
      const direction = [DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND].includes(type) ? Direction.IN : Direction.OUT;
      const doc = await this.posting.createDocument(qr, { documentType: type, warehouseId: warehouse.id, notes: dto.notes, operator: user, lines: lines.map((line: any) => ({ ...line, direction: type === DocumentType.INVENTORY_ADJUSTMENT ? line.direction : direction })) }, userId);
      await this.audit.log(userId, 'CREATE_STOCK_DOCUMENT', 'stock_documents', doc.id, { type }, qr.manager);
      await qr.commitTransaction(); return this.get(doc.id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async createMove(dto: any, user: AuthUser) {
    const userId = user.id;
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const [source] = await qr.query(`SELECT id FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [dto.warehouseId]);
      if (!source) throw new BusinessException('VALIDATION_ERROR', '来源仓库不存在或已停用');
      if (!Array.isArray(dto.lines) || !dto.lines.length) throw new BusinessException('VALIDATION_ERROR', '移库单至少包含一条明细');
      for (const line of dto.lines) {
        if (!line.targetWarehouseId || !line.targetLocationId) throw new BusinessException('VALIDATION_ERROR', '请完整选择移库目标仓库和库位');
        if (line.targetWarehouseId === dto.warehouseId && line.targetLocationId === line.locationId) throw new BusinessException('VALIDATION_ERROR', '移库来源和目标不能相同');
      }
      await this.warehouseAccess.assertWarehouses(user, [dto.warehouseId, ...dto.lines.map((line: any) => line.targetWarehouseId)]);
      await this.validateMoveLines(qr, dto.lines, dto.warehouseId);
      const doc = await this.posting.createDocument(qr, { documentType: DocumentType.STOCK_MOVE, warehouseId: dto.warehouseId, notes: dto.notes, operator: user, lines: dto.lines.map((line: any) => ({ ...line, direction: Direction.OUT })) }, userId);
      await this.audit.log(userId, 'CREATE_STOCK_MOVE', 'stock_documents', doc.id, undefined, qr.manager);
      await qr.commitTransaction(); return this.get(doc.id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async update(id: string, dto: any, user: AuthUser) {
    const userId = user.id;
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const [doc] = await qr.query(`SELECT * FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      await this.assertDocumentOperation(qr, id, user, doc.warehouse_id);
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
      if (doc.document_type === DocumentType.STOCK_MOVE) await this.warehouseAccess.assertWarehouses(user, [doc.warehouse_id, ...lines.map((line: any) => line.targetWarehouseId)]);
      const direction = [DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND].includes(doc.document_type) ? Direction.IN : Direction.OUT;
      await qr.query(`UPDATE stock_documents SET notes=$1,status='DRAFT',submitted_by=NULL,submitted_at=NULL,rejection_reason=NULL,updated_at=now() WHERE id=$2`, [dto.notes || null, id]);
      await qr.query(`DELETE FROM stock_document_lines WHERE document_id=$1`, [id]);
      for (const line of lines) await this.insertLine(qr, id, doc.warehouse_id, { ...line, direction });
      await this.audit.log(userId, 'UPDATE_STOCK_DOCUMENT', 'stock_documents', id, undefined, qr.manager);
      await qr.commitTransaction(); return this.get(id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async remove(id: string, user: AuthUser) {
    return this.cancel(id, user);
  }

  async cancel(id: string, user: AuthUser) {
    const userId = user.id;
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const [doc] = await qr.query(`SELECT status,warehouse_id FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      await this.assertDocumentOperation(qr, id, user, doc.warehouse_id);
      if (!['DRAFT', 'REJECTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS', '只有草稿或已驳回单据可以取消');
      await this.reservations.releaseDocument(qr, id);
      await qr.query(`UPDATE stock_documents SET status='CANCELLED',updated_at=now() WHERE id=$1`, [id]);
      await this.approvalHistory.record(qr, id, 'CANCELLED', doc.status, 'CANCELLED', userId, { reason:'用户取消单据' });
      await this.audit.log(userId, 'CANCEL_STOCK_DOCUMENT', 'stock_documents', id, undefined, qr.manager);
      await qr.commitTransaction();
      return this.get(id);
    } catch (error) { await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async submit(id: string, user: AuthUser, context: ApprovalContext = {}) {
    const userId = user.id;
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try { const [doc] = await qr.query(`SELECT status,warehouse_id,document_type FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]); if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在'); await this.assertDocumentOperation(qr,id,user,doc.warehouse_id); if (doc.status==='SUBMITTED') { await qr.commitTransaction(); return this.get(id); } if (!['DRAFT','REJECTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS', '只有草稿或已驳回单据可以提交');
      if (doc.document_type === DocumentType.STOCK_CHECK) await this.captureStockCheckSnapshot(qr,id);
      else {
        const operationLines = await qr.query(`SELECT location_id "locationId",target_location_id "targetLocationId",item_id "itemId",direction FROM stock_document_lines WHERE document_id=$1`, [id]);
        await this.operations?.assertOperationAllowed(qr, operationLines.flatMap((line: any) => [line.locationId,line.targetLocationId]), operationLines.flatMap((line: any) => line.targetLocationId?[{locationId:line.targetLocationId,itemId:line.itemId}]:line.direction===Direction.IN?[{locationId:line.locationId,itemId:line.itemId}]:[]));
        await this.reservations.reserveDocument(qr,id);
      }
      await qr.query(`UPDATE stock_documents SET status='SUBMITTED',submitted_by=$1,submitted_by_user_id=$1,
        submitted_by_username=(SELECT username FROM users WHERE id=$1),submitted_by_name=(SELECT name FROM users WHERE id=$1),
        submitted_at=now(),updated_at=now() WHERE id=$2`, [userId,id]);
      await this.workflow.submit(qr, id, userId, doc.status);
      await this.audit.log(userId,'SUBMIT_STOCK_DOCUMENT','stock_documents',id,undefined,qr.manager); await qr.commitTransaction(); return this.get(id);
    } catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
  }

  async itemLocationInventory(q: { warehouseId: string; itemId: string; purpose: 'INBOUND' | 'OUTBOUND' | 'MOVE_SOURCE' | 'MOVE_TARGET' }, user: AuthUser) {
    if (!['INBOUND', 'OUTBOUND', 'MOVE_SOURCE', 'MOVE_TARGET'].includes(q.purpose)) {
      throw new BusinessException('VALIDATION_ERROR', '库存分布查询用途无效');
    }
    await this.warehouseAccess.assertWarehouse(user, q.warehouseId);
    const [warehouse] = await this.db.query(`SELECT id,warehouse_code "warehouseCode",name FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [q.warehouseId]);
    if (!warehouse) throw new BusinessException('VALIDATION_ERROR', '仓库不存在或已停用');
    const [item] = await this.db.query(`SELECT id,item_code "itemCode",name,unit FROM items WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [q.itemId]);
    if (!item) throw new BusinessException('VALIDATION_ERROR', '物料不存在或已停用');

    const locations = await this.db.query(`
      WITH reserved AS (
        SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity)::numeric(18,0) quantity
        FROM stock_reservations WHERE status='ACTIVE'
        GROUP BY warehouse_id,location_id,item_id,batch_id
      ), incoming AS (
        SELECT warehouse_id,location_id,item_id,sum(quantity)::numeric(18,0) quantity
        FROM location_capacity_reservations WHERE status='ACTIVE'
        GROUP BY warehouse_id,location_id,item_id
      )
      SELECT l.id "locationId",z.id "zoneId",z.code "zoneCode",z.name "zoneName",
        l.code "locationCode",l.name "locationName",cap.capacity::text "capacityQty",
        COALESCE(sum(sb.on_hand_qty),0)::numeric(18,0)::text "onHandQty",
        COALESCE(sum(sb.frozen_qty),0)::numeric(18,0)::text "frozenQty",
        COALESCE(sum(res.quantity),0)::numeric(18,0)::text "reservedQty",
        COALESCE(inc.quantity,0)::numeric(18,0)::text "pendingInboundQty",
        GREATEST(COALESCE(sum(sb.on_hand_qty),0)-COALESCE(sum(sb.frozen_qty),0)-COALESCE(sum(res.quantity),0),0)::numeric(18,0)::text "availableQty"
      FROM warehouse_locations l
      JOIN warehouse_zones z ON z.id=l.zone_id AND z.status='ACTIVE' AND z.deleted_at IS NULL
      LEFT JOIN stock_balances sb ON sb.location_id=l.id AND sb.warehouse_id=$1 AND sb.item_id=$2
      LEFT JOIN reserved res ON res.warehouse_id=sb.warehouse_id AND res.location_id=sb.location_id
        AND res.item_id=sb.item_id AND res.batch_id IS NOT DISTINCT FROM sb.batch_id
      LEFT JOIN location_item_capacities cap ON cap.location_id=l.id AND cap.item_id=$2
      LEFT JOIN incoming inc ON inc.warehouse_id=l.warehouse_id AND inc.location_id=l.id AND inc.item_id=$2
      WHERE l.warehouse_id=$1 AND l.status='ACTIVE' AND l.is_archived=false
      GROUP BY l.id,z.id,cap.capacity,inc.quantity
      ORDER BY (COALESCE(sum(sb.on_hand_qty),0)>0) DESC,z.code,l.code`, [q.warehouseId, q.itemId]);
    const batches = await this.db.query(`
      WITH reserved AS (
        SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity)::numeric(18,0) quantity
        FROM stock_reservations WHERE status='ACTIVE'
        GROUP BY warehouse_id,location_id,item_id,batch_id
      )
      SELECT sb.location_id "locationId",batch.id "batchId",batch.batch_no "batchNo",
        sb.on_hand_qty::numeric(18,0)::text "onHandQty",COALESCE(sb.frozen_qty,0)::numeric(18,0)::text "frozenQty",
        COALESCE(res.quantity,0)::numeric(18,0)::text "reservedQty",
        GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(res.quantity,0),0)::numeric(18,0)::text "availableQty"
      FROM stock_balances sb
      JOIN warehouse_locations l ON l.id=sb.location_id AND l.status='ACTIVE' AND l.is_archived=false
      LEFT JOIN inventory_batches batch ON batch.id=sb.batch_id
      LEFT JOIN reserved res ON res.warehouse_id=sb.warehouse_id AND res.location_id=sb.location_id
        AND res.item_id=sb.item_id AND res.batch_id IS NOT DISTINCT FROM sb.batch_id
      WHERE sb.warehouse_id=$1 AND sb.item_id=$2
      ORDER BY l.code,batch.batch_no NULLS FIRST`, [q.warehouseId, q.itemId]);
    const byLocation = new Map<string, any[]>();
    for (const batch of batches) byLocation.set(batch.locationId, [...(byLocation.get(batch.locationId) || []), batch]);
    const source = q.purpose === 'OUTBOUND' || q.purpose === 'MOVE_SOURCE';
    const result = locations.map((location: any) => {
      const capacity = location.capacityQty === null ? null : new Decimal(location.capacityQty);
      const onHand = new Decimal(location.onHandQty || 0);
      const pendingInbound = new Decimal(location.pendingInboundQty || 0);
      const availableCapacity = capacity === null ? null : Decimal.max(capacity.sub(onHand).sub(pendingInbound), 0).toFixed(0);
      const usageRate = capacity === null ? null : new Decimal(onHand).add(pendingInbound).div(capacity).mul(100).toDecimalPlaces(1).toFixed(1);
      const capacityStatus = capacity === null ? 'UNLIMITED' : capacity.lte(onHand.add(pendingInbound)) ? 'FULL' : new Decimal(onHand).add(pendingInbound).div(capacity).gte(.8) ? 'WARNING' : 'NORMAL';
      return { ...location, availableCapacityQty: availableCapacity, usageRate, capacityStatus, isFull: capacity !== null && capacity.lte(onHand.add(pendingInbound)), batches: byLocation.get(location.locationId) || [] };
    }).filter((location: any) => !source || location.batches.some((batch: any) => new Decimal(batch.availableQty || 0).gt(0)));
    return { warehouse, item, purpose: q.purpose, locations: result };
  }

  async sourceItemOptions(q: { warehouseId: string; purpose: 'OUTBOUND' | 'MOVE_SOURCE'; keyword?: string; page?: string; pageSize?: string }, user: AuthUser) {
    if (!['OUTBOUND', 'MOVE_SOURCE'].includes(q.purpose)) throw new BusinessException('VALIDATION_ERROR', '来源物料查询用途无效');
    await this.warehouseAccess.assertWarehouse(user, q.warehouseId);
    const [warehouse] = await this.db.query(`SELECT id,warehouse_code "warehouseCode",name,warehouse_type "warehouseType" FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [q.warehouseId]);
    if (!warehouse) throw new BusinessException('VALIDATION_ERROR', '仓库不存在或已停用');
    if (q.purpose === 'OUTBOUND' && warehouse.warehouseType !== 'FG') throw new BusinessException('VALIDATION_ERROR', '成品出库只能选择成品仓');
    const itemType = q.purpose === 'OUTBOUND'
      ? ItemType.FINISHED_GOOD
      : warehouse.warehouseType === 'RAW' ? ItemType.MATERIAL : warehouse.warehouseType === 'FG' ? ItemType.FINISHED_GOOD : undefined;
    if (!itemType) throw new BusinessException('VALIDATION_ERROR', q.purpose === 'OUTBOUND' ? '成品出库只能选择成品仓' : '普通移库只支持原材料仓或成品仓');

    const page = parsePage(q.page, 1);
    const pageSize = parsePage(q.pageSize, 100, 100);
    const keyword = q.keyword?.trim() || null;
    const sourceSql = `
      WITH reserved AS (
        SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity)::numeric(18,0) quantity
        FROM stock_reservations WHERE status='ACTIVE'
        GROUP BY warehouse_id,location_id,item_id,batch_id
      ), inventory AS (
        SELECT sb.item_id,
          COALESCE(sum(sb.on_hand_qty),0)::numeric(18,0) "onHandQty",
          COALESCE(sum(sb.frozen_qty),0)::numeric(18,0) "frozenQty",
          COALESCE(sum(res.quantity),0)::numeric(18,0) "reservedQty",
          GREATEST(COALESCE(sum(sb.on_hand_qty),0)-COALESCE(sum(sb.frozen_qty),0)-COALESCE(sum(res.quantity),0),0)::numeric(18,0) "availableQty",
          count(DISTINCT sb.location_id) FILTER (WHERE sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(res.quantity,0)>0)::int "locationCount",
          count(*) FILTER (WHERE sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(res.quantity,0)>0)::int "batchCount"
        FROM stock_balances sb
        JOIN warehouse_locations l ON l.id=sb.location_id AND l.status='ACTIVE' AND l.is_archived=false
        LEFT JOIN reserved res ON res.warehouse_id=sb.warehouse_id AND res.location_id=sb.location_id
          AND res.item_id=sb.item_id AND res.batch_id IS NOT DISTINCT FROM sb.batch_id
        WHERE sb.warehouse_id=$1
        GROUP BY sb.item_id
      )
      SELECT i.id "itemId",i.item_code "itemCode",i.name,i.model,i.unit,
        inv."onHandQty"::text "onHandQty",inv."frozenQty"::text "frozenQty",inv."reservedQty"::text "reservedQty",
        inv."availableQty"::text "availableQty",inv."locationCount",inv."batchCount"
      FROM inventory inv
      JOIN items i ON i.id=inv.item_id
      WHERE i.status='ACTIVE' AND i.deleted_at IS NULL AND i.item_type=$2
        AND inv."availableQty">0
        AND ($3::text IS NULL OR i.item_code ILIKE '%' || $3 || '%' OR i.name ILIKE '%' || $3 || '%' OR COALESCE(i.model,'') ILIKE '%' || $3 || '%')`;
    const [{ total }] = await this.db.query(`SELECT count(*)::int total FROM (${sourceSql}) candidates`, [q.warehouseId, itemType, keyword]);
    const items = await this.db.query(`${sourceSql} ORDER BY "itemCode" LIMIT $4 OFFSET $5`, [q.warehouseId, itemType, keyword, pageSize, (page - 1) * pageSize]);
    return { items, total: Number(total || 0), page, pageSize, warehouse };
  }

  private async createApprovalTask(qr: QueryRunner, documentId: string, applicantId: string) {
    const [applicant] = await qr.query(`SELECT u.name,u.manager_user_id,m.name manager_name,m.status manager_status,m.can_approve
      FROM users u LEFT JOIN users m ON m.id=u.manager_user_id WHERE u.id=$1 FOR SHARE`, [applicantId]);
    if (!applicant?.manager_user_id || applicant.manager_status !== 'ACTIVE' || !applicant.can_approve) {
      throw new BusinessException('APPROVAL_MANAGER_MISSING', '当前账号尚未配置有效的上级审批人员，请联系系统管理员完成配置');
    }
    const [instance] = await qr.query(`INSERT INTO approval_instance(document_id,business_type,business_id,applicant_user_id,applicant_name,status)
      VALUES($1,(SELECT document_type FROM stock_documents WHERE id=$1),$1,$2,$3,'PENDING')
      ON CONFLICT(document_id) DO UPDATE SET status='PENDING',completed_at=NULL RETURNING id`, [documentId, applicantId, applicant.name]);
    await qr.query(`UPDATE approval_task SET status='CANCELLED',approved_at=now() WHERE approval_instance_id=$1 AND status='PENDING'`, [instance.id]);
    await qr.query(`INSERT INTO approval_task(approval_instance_id,approver_user_id,approver_name,status)
      VALUES($1,$2,$3,'PENDING') ON CONFLICT(approval_instance_id,approver_user_id) DO UPDATE SET status='PENDING',approved_at=NULL`,
      [instance.id, applicant.manager_user_id, applicant.manager_name]);
    const [doc] = await qr.query(`SELECT document_no,document_type FROM stock_documents WHERE id=$1`, [documentId]);
    await qr.query(`INSERT INTO notification(receiver_user_id,type,title,content,business_type,business_id)
      VALUES($1,'APPROVAL_SUBMITTED','新的审批待办',$2,$3,$4)`, [applicant.manager_user_id, `单据 ${doc.document_no} 已提交，请及时审批。`, doc.document_type, documentId]);
  }
  async withdraw(id: string, user: AuthUser, context: ApprovalContext = {}) {
    const userId = user.id;
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try { const [doc] = await qr.query(`SELECT status,warehouse_id FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]); if (!doc || doc.status !== 'SUBMITTED') throw new BusinessException('INVALID_STATUS', '只有待审核单据可以撤回'); await this.assertDocumentOperation(qr,id,user,doc.warehouse_id);
      await this.reservations.releaseDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='DRAFT',submitted_by=NULL,submitted_by_user_id=NULL,
        submitted_by_username=NULL,submitted_by_name=NULL,submitted_at=NULL,updated_at=now() WHERE id=$1`, [id]);
      await this.workflow.closePending(qr,id,'REVOKED',context.reason);
      await this.approvalHistory.record(qr,id,'WITHDRAWN','SUBMITTED','DRAFT',userId,context); await this.audit.log(userId,'WITHDRAW_STOCK_DOCUMENT','stock_documents',id,undefined,qr.manager); await qr.commitTransaction(); return this.get(id);
    } catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
  }

  approve(id: string, dto: any, key: string | undefined, userId: string, context: ApprovalContext = {}) {
    return this.posting.executeIdempotent(userId, key, 'POST:/approvals/:id/approve', { id, receiptAllocations: dto?.receiptAllocations || null }, async qr => {
      const [doc] = await qr.query(`SELECT document_type,status FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      if ([DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND, DocumentType.PRODUCTION_RETURN, DocumentType.PRODUCTION_COMPLETION].includes(doc.document_type)) await this.saveReceiptAllocations(qr, id, dto?.receiptAllocations);
      const result = await this.applyAndFinalize(qr, id, userId, ['SUBMITTED']);
      await this.approvalHistory.record(qr,id,'APPROVED','SUBMITTED','POSTED',userId,{ ...context, idempotencyKey:key }); await this.finishApprovalTask(qr,id,userId,'APPROVED'); return result;
    });
  }

  async reject(id: string, reason: string | undefined, userId: string, context: ApprovalContext = {}) {
    if (!reason?.trim()) throw new BusinessException('VALIDATION_ERROR', '请填写驳回原因');
    const execute = async (qr: QueryRunner) => { const [doc] = await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`,[id]); if (!doc || doc.status !== 'SUBMITTED') throw new BusinessException('INVALID_STATUS','只有待审核单据可以驳回');
      await this.reservations.releaseDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='REJECTED',rejected_by=$1,rejected_by_user_id=$1,
        rejected_by_username=(SELECT username FROM users WHERE id=$1),rejected_by_name=(SELECT name FROM users WHERE id=$1),
        rejected_at=now(),rejection_reason=$2,updated_at=now() WHERE id=$3`,[userId,reason,id]);
      await this.approvalHistory.record(qr,id,'REJECTED','SUBMITTED','REJECTED',userId,{...context,reason}); await this.finishApprovalTask(qr,id,userId,'REJECTED',reason); await this.audit.log(userId,'REJECT_STOCK_DOCUMENT','stock_documents',id,{reason},qr.manager); return this.get(id); };
    if (context.idempotencyKey) return this.posting.executeIdempotent(userId,context.idempotencyKey,'POST:/approvals/:id/reject',{id,reason,reasonCode:context.reasonCode||null},execute);
    const qr=this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction(); try { const result=await execute(qr); await qr.commitTransaction(); return result; } catch(e){await qr.rollbackTransaction();throw e;} finally {await qr.release();}
  }

  private async finishApprovalTask(qr: QueryRunner, documentId: string, actorId: string, status: 'APPROVED'|'REJECTED', reason?: string) {
    const [row] = await qr.query(`SELECT a.id,a.applicant_user_id,d.document_no,d.document_type FROM approval_instance a JOIN stock_documents d ON d.id=a.document_id WHERE a.document_id=$1 FOR UPDATE`, [documentId]);
    if (!row) return;
    const updated = await qr.query(`UPDATE approval_task SET status=$1,approval_opinion=$2,approved_at=now() WHERE approval_instance_id=$3 AND approver_user_id=$4 AND status='PENDING'`, [status, reason || null, row.id, actorId]);
    if (!updated[1]) throw new BusinessException('FORBIDDEN', '当前账号不是该审批任务的审批人');
    await qr.query(`UPDATE approval_instance SET status=$1,completed_at=now() WHERE id=$2`, [status, row.id]);
    await qr.query(`INSERT INTO notification(receiver_user_id,type,title,content,business_type,business_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [row.applicant_user_id, status === 'APPROVED' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED', status === 'APPROVED' ? '审批已通过' : '审批已驳回',
        status === 'APPROVED' ? `单据 ${row.document_no} 已审批通过。` : `单据 ${row.document_no} 已驳回：${reason || '请查看详情。'}`, row.document_type, documentId]);
  }

  void(id: string, reason: string | undefined, key: string | undefined, user: AuthUser) {
    const userId = user.id;
    return this.posting.executeIdempotent(userId, key, 'POST:/stock-documents/:id/void', { id, reason: reason || null }, async qr => {
      const [original] = await qr.query(`SELECT * FROM stock_documents WHERE id=$1 FOR UPDATE`, [id]);
      if (!original) throw new BusinessException('NOT_FOUND', '库存单据不存在');
      await this.assertDocumentOperation(qr, id, user, original.warehouse_id);
      if (original.status !== 'POSTED' || original.document_type === DocumentType.REVERSAL) throw new BusinessException('INVALID_STATUS', '只有已过账的非冲销单据可以冲销');
      const transactions = await qr.query(`SELECT t.warehouse_id,t.location_id,t.item_id,t.batch_id,abs(t.delta_qty)::text quantity,CASE WHEN t.delta_qty>0 THEN 'OUT' ELSE 'IN' END direction FROM stock_transactions t WHERE t.source_document_id=$1 ORDER BY t.warehouse_id,t.location_id,t.item_id`, [id]);
      if (original.document_type === DocumentType.STOCK_CHECK && !transactions.length) {
        await qr.query(`UPDATE stock_documents SET status='VOIDED',voided_by=$1,voided_by_user_id=$1,voided_by_username=(SELECT username FROM users WHERE id=$1),voided_by_name=(SELECT COALESCE(employee_name,name) FROM users WHERE id=$1),voided_at=now(),updated_at=now() WHERE id=$2`,[userId,id]);
        await this.audit.log(userId,'VOID_ZERO_DIFFERENCE_STOCK_CHECK','stock_documents',id,{reason},qr.manager);
        return {id,documentNo:original.document_no,documentType:DocumentType.STOCK_CHECK,status:'VOIDED',lines:[]};
      }
      const reversal = await this.posting.createDocument(qr, { documentType: DocumentType.REVERSAL, warehouseId: original.warehouse_id, productionOrderId: original.production_order_id, originalDocumentId: id, notes: reason || `冲销 ${original.document_no}`, lines: transactions.map((line: any) => ({ itemId: line.item_id, quantity: line.quantity, locationId: line.location_id, targetWarehouseId: line.warehouse_id, batchId: line.batch_id, direction: line.direction })) }, userId);
      const posted = await this.posting.applyDocument(qr, reversal.id, userId, ['DRAFT']);
      await qr.query(`UPDATE stock_documents SET status='VOIDED',voided_by=$1,voided_by_user_id=$1,
        voided_by_username=(SELECT username FROM users WHERE id=$1),voided_by_name=(SELECT name FROM users WHERE id=$1),
        voided_at=now(),updated_at=now() WHERE id=$2`, [userId, id]);
      if (original.production_order_id) await this.reverseProduction(qr, original);
      await qr.query(`UPDATE defective_inventory_lots SET remaining_qty=0,status='RESOLVED',updated_at=now() WHERE source_document_id=$1`, [id]);
      await this.audit.log(userId, 'VOID_STOCK_DOCUMENT', 'stock_documents', id, { reversalId: reversal.id, reason }, qr.manager); return { ...posted, originalDocumentId: id };
    });
  }

  async createAdjustment(dto: any, user: AuthUser) { const lines = dto.lines.map((line: any) => { const value = new Decimal(line.adjustmentQty); if (!value.isFinite() || value.isZero() || !value.isInteger()) throw new BusinessException('VALIDATION_ERROR', '调整数量必须是非零整数'); return { ...line, quantity: value.abs().toFixed(0), direction: value.isPositive() ? Direction.IN : Direction.OUT }; }); return this.create(DocumentType.INVENTORY_ADJUSTMENT, { ...dto, lines }, user); }

  async createStockCheck(dto: any, user: AuthUser) {
    if (!dto.warehouseId || !Array.isArray(dto.lines) || !dto.lines.length) throw new BusinessException('VALIDATION_ERROR', '请选择仓库并填写盘点明细');
    await this.warehouseAccess.assertWarehouse(user,dto.warehouseId);
    const qr=this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const lines = dto.lines.map((line: any) => ({ ...line,countedQty:new Decimal(line.countedQty).toFixed(0) }));
      await this.validateLocations(qr,lines,dto.warehouseId,false);
      await this.validateStockCheckLines(qr,lines);
      await this.operations?.assertOperationAllowed(qr,lines.map((line: any)=>line.locationId));
      const doc=await this.posting.createStockCheckDocument(qr,{warehouseId:dto.warehouseId,notes:dto.notes,lines,operator:user},user.id);
      await this.audit.log(user.id,'CREATE_STOCK_CHECK','stock_documents',doc.id,undefined,qr.manager);
      await qr.commitTransaction(); return this.get(doc.id,user);
    } catch(e){await qr.rollbackTransaction();throw e;} finally {await qr.release();}
  }

  async updateStockCheck(id:string,dto:any,user:AuthUser){
    const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();
    try{const [doc]=await qr.query(`SELECT * FROM stock_documents WHERE id=$1 FOR UPDATE`,[id]);if(!doc||doc.document_type!==DocumentType.STOCK_CHECK)throw new BusinessException('NOT_FOUND','盘点单不存在');await this.assertDocumentOperation(qr,id,user,doc.warehouse_id);if(!['DRAFT','REJECTED','SUBMITTED'].includes(doc.status))throw new BusinessException('INVALID_STATUS','当前盘点单不能编辑');
      const lines=dto.lines.map((line:any)=>({...line,countedQty:new Decimal(line.countedQty).toFixed(0)}));await this.validateLocations(qr,lines,doc.warehouse_id,false);await this.validateStockCheckLines(qr,lines);await this.operations?.assertOperationAllowed(qr,lines.map((line:any)=>line.locationId));
      if(doc.status==='SUBMITTED'){await this.workflow.closePending(qr,id,'REVOKED','编辑待审批盘点单自动撤回');await this.approvalHistory.record(qr,id,'WITHDRAWN','SUBMITTED','DRAFT',user.id,{reason:'编辑待审批盘点单自动撤回'});}
      await qr.query(`DELETE FROM stock_check_lines WHERE document_id=$1`,[id]);for(const line of lines)await qr.query(`INSERT INTO stock_check_lines(document_id,warehouse_id,location_id,item_id,batch_id,counted_qty,notes) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,doc.warehouse_id,line.locationId,line.itemId,line.batchId||null,line.countedQty,line.notes||null]);
      await qr.query(`UPDATE stock_documents SET notes=$1,status='DRAFT',submitted_by=NULL,submitted_by_user_id=NULL,submitted_by_username=NULL,submitted_by_name=NULL,submitted_at=NULL,rejection_reason=NULL,updated_at=now() WHERE id=$2`,[dto.notes||null,id]);
      await this.audit.log(user.id,'UPDATE_STOCK_CHECK','stock_documents',id,undefined,qr.manager);await qr.commitTransaction();return this.get(id,user);
    }catch(e){await qr.rollbackTransaction();throw e;}finally{await qr.release();}
  }

  async allocationPreview(dto: any,user:AuthUser) {
    const operation=String(dto.operationType||'').toUpperCase();
    if (!['INBOUND','OUTBOUND','MOVE'].includes(operation) || !dto.warehouseId || !Array.isArray(dto.lines) || !dto.lines.length) throw new BusinessException('VALIDATION_ERROR','自动分配参数不完整');
    const targetWarehouseId=dto.targetWarehouseId||dto.warehouseId;
    await this.warehouseAccess.assertWarehouses(user,operation==='MOVE'?[dto.warehouseId,targetWarehouseId]:[dto.warehouseId]);
    if (operation==='MOVE' && targetWarehouseId!==dto.warehouseId) {
      const warehouses=await this.db.query(`SELECT id,warehouse_type FROM warehouses WHERE id=ANY($1::uuid[]) AND status='ACTIVE' AND deleted_at IS NULL`,[[dto.warehouseId,targetWarehouseId]]);
      if(warehouses.length!==2||warehouses[0].warehouse_type!==warehouses[1].warehouse_type) throw new BusinessException('VALIDATION_ERROR','跨仓调拨只允许同仓型仓库');
    }
    const allocations:any[]=[];
    for(const input of dto.lines){
      const requested=new Decimal(input.quantity||0); if(!requested.isPositive()||!requested.isInteger()) throw new BusinessException('VALIDATION_ERROR','分配数量必须是正整数');
      let sources:any[]=[],sourceAllocations:any[]=[];
      if(operation!=='INBOUND'){
        sources=await this.db.query(`WITH reserved AS (SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id,batch_id)
          SELECT sb.location_id "locationId",sb.batch_id "batchId",l.code "locationCode",z.code "zoneCode",COALESCE(b.batch_no,'') "batchNo",GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0)::numeric(18,0)::text available
          FROM stock_balances sb JOIN warehouse_locations l ON l.id=sb.location_id JOIN warehouse_zones z ON z.id=l.zone_id LEFT JOIN inventory_batches b ON b.id=sb.batch_id LEFT JOIN reserved r ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
          WHERE sb.warehouse_id=$1 AND sb.item_id=$2 AND l.status='ACTIVE' AND l.is_archived=false AND ($3::uuid IS NULL OR l.zone_id=$3) AND ($4::uuid IS NULL OR l.id=$4)
          AND NOT EXISTS(SELECT 1 FROM warehouse_operation_locks ol WHERE ol.status='ACTIVE' AND ol.warehouse_id=l.warehouse_id AND (ol.scope_type='WAREHOUSE' OR ol.zone_id=l.zone_id OR ol.location_id=l.id))
          ORDER BY GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0) ASC,z.code,l.code,b.batch_no NULLS FIRST`,[dto.warehouseId,input.itemId,dto.zoneId||null,dto.locationId||null]);
        let remaining=requested;
        for(const source of sources){const take=Decimal.min(remaining,source.available);if(take.gt(0)){sourceAllocations.push({itemId:input.itemId,quantity:take.toFixed(0),locationId:source.locationId,batchId:source.batchId,sourceBeforeQty:source.available});remaining=remaining.sub(take);}if(remaining.isZero())break;}
        if(remaining.gt(0))throw new BusinessException('INSUFFICIENT_STOCK','可用库存不足，无法生成完整分配预览',undefined,{itemId:input.itemId,shortageQty:remaining.toFixed(0)});
        if(operation==='OUTBOUND')allocations.push(...sourceAllocations);
      }
      if(operation==='INBOUND'){
        const targets=await this.targetCandidates(targetWarehouseId,input.itemId,dto.targetZoneId||dto.zoneId,dto.targetLocationId||dto.locationId,[]);
        allocations.push(...this.allocateTargets(targets,input.itemId,requested));
      } else if(operation==='MOVE'){
        const targets=await this.targetCandidates(targetWarehouseId,input.itemId,dto.targetZoneId,dto.targetLocationId,sourceAllocations.map(row=>row.locationId));
        const targetAllocations=this.allocateTargets(targets,input.itemId,requested);
        let targetIndex=0,targetRemaining=new Decimal(targetAllocations[0]?.quantity||0);
        for(const source of sourceAllocations){let sourceRemaining=new Decimal(source.quantity);while(sourceRemaining.gt(0)){const target=targetAllocations[targetIndex];const take=Decimal.min(sourceRemaining,targetRemaining);allocations.push({...source,quantity:take.toFixed(0),targetWarehouseId,targetLocationId:target.locationId,targetBeforeQty:target.targetBeforeQty,capacityQty:target.capacityQty,moveCategory:targetWarehouseId===dto.warehouseId?'MOVE_LOCATION':'TRANSFER_WAREHOUSE'});sourceRemaining=sourceRemaining.sub(take);targetRemaining=targetRemaining.sub(take);if(targetRemaining.isZero()){targetIndex+=1;targetRemaining=new Decimal(targetAllocations[targetIndex]?.quantity||0);}}}
      }
    }
    return {operationType:operation,moveCategory:operation==='MOVE'?(targetWarehouseId===dto.warehouseId?'MOVE_LOCATION':'TRANSFER_WAREHOUSE'):null,allocations};
  }

  private async targetCandidates(warehouseId:string,itemId:string,zoneId?:string,locationId?:string,exclude:string[]=[]){
    return this.db.query(`WITH stock AS (SELECT location_id,sum(on_hand_qty) qty FROM stock_balances WHERE item_id=$2 GROUP BY location_id),incoming AS (SELECT location_id,sum(quantity) qty FROM location_capacity_reservations WHERE item_id=$2 AND status='ACTIVE' GROUP BY location_id)
      SELECT l.id "locationId",l.code "locationCode",z.code "zoneCode",COALESCE(s.qty,0)::text "onHandQty",cap.capacity::text "capacityQty",CASE WHEN cap.capacity IS NULL THEN NULL ELSE GREATEST(cap.capacity-COALESCE(s.qty,0)-COALESCE(inc.qty,0),0)::text END "remainingQty",(COALESCE(s.qty,0)>0) "hasItem"
      FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id LEFT JOIN stock s ON s.location_id=l.id LEFT JOIN incoming inc ON inc.location_id=l.id LEFT JOIN location_item_capacities cap ON cap.location_id=l.id AND cap.item_id=$2
      WHERE l.warehouse_id=$1 AND l.status='ACTIVE' AND l.is_archived=false AND ($3::uuid IS NULL OR l.zone_id=$3) AND ($4::uuid IS NULL OR l.id=$4) AND NOT(l.id=ANY($5::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM location_item_rules r WHERE r.location_id=l.id AND r.item_id=$2 AND r.allowed=false)
      AND NOT EXISTS(SELECT 1 FROM warehouse_operation_locks ol WHERE ol.status='ACTIVE' AND ol.warehouse_id=l.warehouse_id AND (ol.scope_type='WAREHOUSE' OR ol.zone_id=l.zone_id OR ol.location_id=l.id))
      ORDER BY (COALESCE(s.qty,0)>0) DESC,(cap.capacity IS NULL),CASE WHEN cap.capacity IS NULL THEN 999999999999999999::numeric ELSE GREATEST(cap.capacity-COALESCE(s.qty,0)-COALESCE(inc.qty,0),0) END,z.code,l.code`,[warehouseId,itemId,zoneId||null,locationId||null,exclude]);
  }

  private allocateTargets(targets:any[],itemId:string,requested:Decimal){let remaining=requested;const rows:any[]=[];const ordered=[...targets].sort((a,b)=>{if(Boolean(a.hasItem)!==Boolean(b.hasItem))return a.hasItem?-1:1;const af=a.remainingQty!==null&&new Decimal(a.remainingQty).gte(requested),bf=b.remainingQty!==null&&new Decimal(b.remainingQty).gte(requested);if(af!==bf)return af?-1:1;if(a.remainingQty===null||b.remainingQty===null)return a.remainingQty===null?1:-1;return new Decimal(a.remainingQty).cmp(b.remainingQty);});for(const target of ordered){const available=target.remainingQty===null?remaining:new Decimal(target.remainingQty);const take=Decimal.min(remaining,available);if(take.gt(0))rows.push({itemId,quantity:take.toFixed(0),locationId:target.locationId,targetBeforeQty:target.onHandQty,capacityQty:target.capacityQty});remaining=remaining.sub(take);if(remaining.isZero())break;}if(remaining.gt(0))throw new BusinessException('LOCATION_CAPACITY_EXCEEDED','目标库位容量不足，无法生成完整分配预览',undefined,{itemId,shortageQty:remaining.toFixed(0)});return rows;}

  private async captureStockCheckSnapshot(qr:QueryRunner,id:string){
    const lines=await qr.query(`SELECT * FROM stock_check_lines WHERE document_id=$1 ORDER BY location_id,item_id,batch_id NULLS FIRST`,[id]);
    if(!lines.length)throw new BusinessException('VALIDATION_ERROR','盘点单没有明细');
    await this.operations?.assertOperationAllowed(qr,lines.map((line:any)=>line.location_id));
    for(const line of lines){const [balance]=await qr.query(`SELECT on_hand_qty FROM stock_balances WHERE warehouse_id=$1 AND location_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4 FOR UPDATE`,[line.warehouse_id,line.location_id,line.item_id,line.batch_id]);const snapshot=new Decimal(balance?.on_hand_qty||0);await qr.query(`UPDATE stock_check_lines SET system_qty_snapshot=$1,difference_qty=$2,updated_at=now() WHERE id=$3`,[snapshot.toFixed(0),new Decimal(line.counted_qty).sub(snapshot).toFixed(0),line.id]);}
  }

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
        const quantity = new Decimal(row.quantity || 0);
        if (!['NORMAL', 'DEFECTIVE'].includes(row.disposition) || !quantity.isPositive() || !quantity.isInteger() || !row.warehouseId || !row.locationId) throw new BusinessException('VALIDATION_ERROR', '入库审核分配必须填写完整的整数数量、仓库和库位');
        if (row.disposition === 'DEFECTIVE' && !String(row.defectReason || '').trim()) throw new BusinessException('VALIDATION_ERROR', '不良品必须逐行填写不良原因');
        await qr.query(`INSERT INTO stock_document_receipt_allocations(id,document_line_id,disposition,warehouse_id,location_id,batch_id,quantity,defect_reason) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`, [line.id, row.disposition, row.warehouseId, row.locationId, row.batchId || line.batch_id || null, quantity.toFixed(0), row.disposition === 'DEFECTIVE' ? String(row.defectReason).trim() : null]);
      }
    }
    await this.reservations.reserveIncomingCapacity(qr, documentId);
  }

  private async applyAndFinalize(qr: QueryRunner, id: string, userId: string, allowedStatuses: string[]) {
    const [doc] = await qr.query(`SELECT document_type,production_order_id FROM stock_documents WHERE id=$1`, [id]);
    if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
    if (!doc.production_order_id) return this.posting.applyDocument(qr, id, userId, allowedStatuses);
    const [order] = await qr.query(`SELECT * FROM production_orders WHERE id=$1 FOR UPDATE`, [doc.production_order_id]);
    if (!order || !['RELEASED', 'IN_PROGRESS'].includes(order.status)) throw new BusinessException('INVALID_STATUS', '生产任务已完成或取消，不能审核该单据');
    const lines = await qr.query(`SELECT item_id,sum(quantity)::numeric(18,0) quantity,sum(normal_qty)::numeric(18,0) normal_qty,sum(spare_qty)::numeric(18,0) spare_qty FROM stock_document_lines WHERE document_id=$1 GROUP BY item_id`, [id]);
    const materials = await qr.query(`SELECT * FROM production_order_materials WHERE production_order_id=$1 FOR UPDATE`, [doc.production_order_id]);
    if ([DocumentType.PRODUCTION_ISSUE, DocumentType.PRODUCTION_RETURN].includes(doc.document_type)) for (const line of lines) {
      const material = materials.find((row: any) => row.material_id === line.item_id); if (!material) throw new BusinessException('VALIDATION_ERROR', '单据物料不属于生产任务 BOM');
      const net = new Decimal(material.issued_qty).sub(material.returned_qty);
      if (doc.document_type === DocumentType.PRODUCTION_ISSUE && net.add(line.normal_qty || line.quantity).gt(material.required_qty)) throw new BusinessException('VALIDATION_ERROR', '审核后正常净领料将超过 BOM 需求量');
      if (doc.document_type === DocumentType.PRODUCTION_ISSUE && new Decimal(material.spare_issued_qty || 0).add(line.spare_qty || 0).gt(new Decimal(material.required_qty).mul('0.1'))) throw new BusinessException('VALIDATION_ERROR', '审核后备用件累计将超过 BOM 需求量的 10%');
      if (doc.document_type === DocumentType.PRODUCTION_RETURN && new Decimal(line.quantity).gt(net)) throw new BusinessException('VALIDATION_ERROR', '审核后退料量将超过当前净领料量');
    }
    const total = lines.reduce((sum: Decimal, line: any) => sum.add(line.quantity), new Decimal(0));
    const qualifiedTotal = doc.document_type === DocumentType.PRODUCTION_COMPLETION
      ? new Decimal((await qr.query(`SELECT COALESCE(sum(a.quantity),0)::text quantity FROM stock_document_receipt_allocations a JOIN stock_document_lines l ON l.id=a.document_line_id WHERE l.document_id=$1 AND a.disposition='NORMAL'`,[id]))[0]?.quantity || 0)
      : total;
    if (doc.document_type === DocumentType.PRODUCTION_COMPLETION && new Decimal(order.completed_qty).add(qualifiedTotal).gt(order.planned_qty)) throw new BusinessException('VALIDATION_ERROR', '审核后合格品累计完工将超过计划数量');
    const result = await this.posting.applyDocument(qr, id, userId, allowedStatuses);
    if (doc.document_type === DocumentType.PRODUCTION_ISSUE) {
      for (const line of lines) await qr.query(`UPDATE production_order_materials SET issued_qty=issued_qty+$1,spare_issued_qty=spare_issued_qty+$2 WHERE production_order_id=$3 AND material_id=$4`, [line.normal_qty || line.quantity,line.spare_qty || 0,doc.production_order_id,line.item_id]);
      await qr.query(`UPDATE production_orders SET status='IN_PROGRESS',updated_at=now() WHERE id=$1`, [doc.production_order_id]);
    }
    if (doc.document_type === DocumentType.PRODUCTION_RETURN) {
      for (const line of lines) await qr.query(`UPDATE production_order_materials SET returned_qty=returned_qty+$1 WHERE production_order_id=$2 AND material_id=$3`, [line.quantity,doc.production_order_id,line.item_id]);
      await qr.query(`UPDATE production_orders SET status='IN_PROGRESS',updated_at=now() WHERE id=$1`, [doc.production_order_id]);
    }
    if (doc.document_type === DocumentType.PRODUCTION_COMPLETION) { const completed = new Decimal(order.completed_qty).add(qualifiedTotal); const status = completed.eq(order.planned_qty) ? 'COMPLETED' : 'IN_PROGRESS'; await qr.query(`UPDATE production_orders SET completed_qty=$1,status=$2,updated_at=now() WHERE id=$3`, [completed.toFixed(0), status, doc.production_order_id]); return { ...result, productionStatus: status, completedQty: completed.toFixed(0) }; }
    return result;
  }

  private async reverseProduction(qr: QueryRunner, doc: any) { const lines = await qr.query(`SELECT item_id,sum(quantity)::numeric(18,0) quantity,sum(normal_qty)::numeric(18,0) normal_qty,sum(spare_qty)::numeric(18,0) spare_qty FROM stock_document_lines WHERE document_id=$1 GROUP BY item_id`, [doc.id]); if (doc.document_type === DocumentType.PRODUCTION_ISSUE) { for (const line of lines) await qr.query(`UPDATE production_order_materials SET issued_qty=issued_qty-$1,spare_issued_qty=spare_issued_qty-$2 WHERE production_order_id=$3 AND material_id=$4`, [line.normal_qty || line.quantity,line.spare_qty || 0,doc.production_order_id,line.item_id]); } if (doc.document_type === DocumentType.PRODUCTION_RETURN) { for (const line of lines) await qr.query(`UPDATE production_order_materials SET returned_qty=returned_qty-$1 WHERE production_order_id=$2 AND material_id=$3`, [line.quantity,doc.production_order_id,line.item_id]); } if (doc.document_type === DocumentType.PRODUCTION_COMPLETION) { const [qualified]=await qr.query(`SELECT COALESCE(sum(a.quantity),0)::text quantity FROM stock_document_receipt_allocations a JOIN stock_document_lines l ON l.id=a.document_line_id WHERE l.document_id=$1 AND a.disposition='NORMAL'`,[doc.id]); await qr.query(`UPDATE production_orders SET completed_qty=completed_qty-$1,status='IN_PROGRESS',updated_at=now() WHERE id=$2`, [qualified.quantity, doc.production_order_id]); } }

  private async fillDefaultLocations(qr: QueryRunner, lines: any[], warehouseId: string) {
    if (!Array.isArray(lines) || lines.every(line => line.locationId)) return lines;
    const [location] = await qr.query(`SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND status='ACTIVE' AND is_archived=false ORDER BY auto_generated DESC,sort_order NULLS LAST,code LIMIT 1`, [warehouseId]);
    if (!location) throw new BusinessException('VALIDATION_ERROR', '仓库没有可用库位');
    return lines.map(line => line.locationId ? line : { ...line, locationId: location.id });
  }

  private async insertLine(qr: QueryRunner, documentId: string, warehouseId: string, line: any) { const locationId = line.locationId; if (!locationId) throw new BusinessException('VALIDATION_ERROR', '仓库没有可用库位'); await qr.query(`INSERT INTO stock_document_lines(id,document_id,item_id,quantity,direction,location_id,batch_id,target_warehouse_id,target_location_id,target_batch_id,notes) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [documentId, line.itemId, line.quantity, line.direction, locationId, line.batchId || null, line.targetWarehouseId || null, line.targetLocationId || null, line.targetBatchId || null, line.notes || null]); }

  private async validateManualLines(qr: QueryRunner, type: DocumentType, lines: any[], warehouseId: string) {
    if (!Array.isArray(lines) || !lines.length) throw new BusinessException('VALIDATION_ERROR', '单据至少包含一条明细');
    const ids = lines.map(line => line.itemId);
    const items = await qr.query(`SELECT id,item_type,status FROM items WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]);
    if (items.length !== ids.length || items.some((item: any) => item.status !== 'ACTIVE')) throw new BusinessException('VALIDATION_ERROR', '单据只能包含启用物料');
    if (type !== DocumentType.INVENTORY_ADJUSTMENT) {
      const expected = type === DocumentType.MATERIAL_INBOUND ? ItemType.MATERIAL : ItemType.FINISHED_GOOD;
      if (items.some((item: any) => item.item_type !== expected)) throw new BusinessException('VALIDATION_ERROR', expected === ItemType.MATERIAL ? '原材料入库只能包含原材料' : '成品入库或出库只能包含成品');
    }
    await this.validateLocations(qr, lines, warehouseId, false);
    await this.operations?.assertOperationAllowed(qr, lines.map(line => line.locationId), [DocumentType.MATERIAL_INBOUND,DocumentType.FINISHED_INBOUND].includes(type)?lines.map(line => ({ locationId: line.locationId,itemId: line.itemId })):[]);
    if ([DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND].includes(type)) {
      await this.validateCapacityAllocations(qr, lines.map(line => ({ locationId: line.locationId, itemId: line.itemId, quantity: line.quantity })));
    }
  }

  private async validateStockCheckLines(qr:QueryRunner,lines:any[]){
    const rows=await qr.query(`SELECT i.id,b.id "batchId",b.item_id "batchItemId" FROM items i LEFT JOIN inventory_batches b ON b.id=ANY($2::uuid[]) WHERE i.id=ANY($1::uuid[]) AND i.status='ACTIVE' AND i.deleted_at IS NULL`,[lines.map(line=>line.itemId),lines.map(line=>line.batchId).filter(Boolean)]);
    const itemIds=new Set(rows.map((row:any)=>row.id));if(itemIds.size!==new Set(lines.map(line=>line.itemId)).size)throw new BusinessException('VALIDATION_ERROR','盘点单只能包含启用物料');
    for(const line of lines)if(line.batchId){const batch=rows.find((row:any)=>row.batchId===line.batchId);if(!batch||batch.batchItemId!==line.itemId)throw new BusinessException('VALIDATION_ERROR','盘点批次与物料不匹配');}
  }

  private async validateMoveLines(qr: QueryRunner, lines: any[], warehouseId: string) {
    await this.validateManualLines(qr, DocumentType.INVENTORY_ADJUSTMENT, lines, warehouseId);
    const [sourceWarehouse] = await qr.query(`SELECT warehouse_type FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [warehouseId]);
    if (!sourceWarehouse || !['RAW','FG'].includes(sourceWarehouse.warehouse_type)) throw new BusinessException('VALIDATION_ERROR', '普通移库只支持原材料仓或成品仓');
    const items = await qr.query(`SELECT id,item_type FROM items WHERE id=ANY($1::uuid[])`, [lines.map(line => line.itemId)]);
    for (const line of lines) {
      const item = items.find((row: any) => row.id === line.itemId);
      const [targetWarehouse] = await qr.query(`SELECT warehouse_type FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [line.targetWarehouseId]);
      const expectedType = sourceWarehouse.warehouse_type === 'RAW' ? ItemType.MATERIAL : ItemType.FINISHED_GOOD;
      if (!targetWarehouse || targetWarehouse.warehouse_type !== sourceWarehouse.warehouse_type || item?.item_type !== expectedType) throw new BusinessException('VALIDATION_ERROR', '原材料只能在原材料仓间移库，成品只能在成品仓间移库');
    }
    await this.validateLocations(qr, lines, warehouseId, true);
    await this.operations?.assertOperationAllowed(qr, lines.flatMap(line => [line.locationId,line.targetLocationId]), lines.flatMap(line => [{ locationId: line.locationId,itemId: line.itemId },{ locationId: line.targetLocationId,itemId: line.itemId }]));
    await this.validateCapacityAllocations(qr, lines.map(line => ({ locationId: line.targetLocationId, itemId: line.itemId, quantity: line.quantity })));
  }

  private async validateAdjustmentLines(qr: QueryRunner, lines: any[], warehouseId: string) {
    const [warehouse] = await qr.query(`SELECT warehouse_type FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [warehouseId]);
    if (!warehouse || !['RAW','FG'].includes(warehouse.warehouse_type)) throw new BusinessException('VALIDATION_ERROR', '库存调整只能在原材料仓或成品仓执行');
    const expectedType = warehouse.warehouse_type === 'RAW' ? ItemType.MATERIAL : ItemType.FINISHED_GOOD;
    const items = await qr.query(`SELECT id,item_type FROM items WHERE id=ANY($1::uuid[]) AND status='ACTIVE' AND deleted_at IS NULL`, [lines.map(line => line.itemId)]);
    if (items.length !== lines.length || items.some((item: any) => item.item_type !== expectedType)) throw new BusinessException('VALIDATION_ERROR', warehouse.warehouse_type === 'RAW' ? '原材料仓只能调整原材料' : '成品仓只能调整成品');
  }

  private async validateLocations(qr: QueryRunner, lines: any[], warehouseId: string, moving: boolean) {
    for (const line of lines) {
      const [source] = await qr.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND status='ACTIVE' AND is_archived=false`, [line.locationId, warehouseId]);
      if (!source) throw new BusinessException('VALIDATION_ERROR', '来源库位不存在、已停用或不属于当前仓库');
      if (moving) {
        const [target] = await qr.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND status='ACTIVE' AND is_archived=false`, [line.targetLocationId, line.targetWarehouseId]);
        if (!target) throw new BusinessException('VALIDATION_ERROR', '移库目标库位不存在、已停用或不属于目标仓库');
      }
    }
  }

  private async validateOutboundAvailability(qr: QueryRunner, lines: any[], warehouseId: string) {
    const grouped = new Map<string, { itemId: string; locationId: string; batchId?: string; quantity: Decimal }>();
    for (const line of lines) {
      const key = `${line.itemId}:${line.locationId}:${line.batchId || ''}`;
      const current = grouped.get(key) || { itemId: line.itemId, locationId: line.locationId, batchId: line.batchId, quantity: new Decimal(0) };
      current.quantity = current.quantity.add(line.quantity || 0);
      grouped.set(key, current);
    }
    for (const allocation of grouped.values()) {
      const [balance] = await qr.query(`
        SELECT sb.on_hand_qty,COALESCE(sb.frozen_qty,0) frozen_qty,COALESCE(res.quantity,0) reserved_qty
        FROM stock_balances sb
        LEFT JOIN (
          SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) quantity FROM stock_reservations WHERE status='ACTIVE'
          GROUP BY warehouse_id,location_id,item_id,batch_id
        ) res ON res.warehouse_id=sb.warehouse_id AND res.location_id=sb.location_id AND res.item_id=sb.item_id AND res.batch_id IS NOT DISTINCT FROM sb.batch_id
        WHERE sb.warehouse_id=$1 AND sb.location_id=$2 AND sb.item_id=$3 AND sb.batch_id IS NOT DISTINCT FROM $4`,
        [warehouseId, allocation.locationId, allocation.itemId, allocation.batchId || null],
      );
      const available = new Decimal(balance?.on_hand_qty || 0).sub(balance?.frozen_qty || 0).sub(balance?.reserved_qty || 0);
      if (!allocation.quantity.isPositive() || available.lt(allocation.quantity)) {
        throw new BusinessException('INSUFFICIENT_STOCK', '出库或移库数量不能超过来源库位批次的实时可用库存', undefined, { locationId: allocation.locationId, availableQty: Decimal.max(available, 0).toFixed(0), requestQty: allocation.quantity.toFixed(0) });
      }
    }
  }

  private async validateCapacityAllocations(qr: QueryRunner, allocations: Array<{ locationId: string; itemId: string; quantity: string }>) {
    const grouped = new Map<string, { locationId: string; itemId: string; quantity: Decimal }>();
    for (const allocation of allocations) {
      const key = `${allocation.locationId}:${allocation.itemId}`;
      const current = grouped.get(key) || { locationId: allocation.locationId, itemId: allocation.itemId, quantity: new Decimal(0) };
      current.quantity = current.quantity.add(allocation.quantity || 0);
      grouped.set(key, current);
    }
    for (const allocation of grouped.values()) {
      const [capacity] = await qr.query(`SELECT capacity FROM location_item_capacities WHERE location_id=$1 AND item_id=$2`, [allocation.locationId, allocation.itemId]);
      if (!capacity) continue;
      const [stock] = await qr.query(`SELECT COALESCE(sum(on_hand_qty),0)::text quantity FROM stock_balances WHERE location_id=$1 AND item_id=$2`, [allocation.locationId, allocation.itemId]);
      const remaining = new Decimal(capacity.capacity).sub(stock?.quantity || 0);
      if (allocation.quantity.gt(remaining)) {
        throw new BusinessException('LOCATION_CAPACITY_EXCEEDED', '目标库位的该物料容量不足，请选择其他库位或拆分数量', undefined, { locationId: allocation.locationId, remainingCapacityQty: Decimal.max(remaining, 0).toFixed(0), requestQty: allocation.quantity.toFixed(0) });
      }
    }
  }

  async get(id: string, user?: AuthUser) {
    if (user) await this.assertDocumentView(id, user);
    const [doc] = await this.db.query(`
      SELECT d.id,d.document_no "documentNo",d.document_type "documentType",d.status,d.notes,
        d.rejection_reason "rejectionReason",d.production_order_id "productionOrderId",po.order_no "productionOrderNo",
        d.original_document_id "originalDocumentId",original.document_no "originalDocumentNo",
        w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
        COALESCE(d.created_by_name,u.name,d.created_by_username,u.username,'—') "createdByName",
        COALESCE(d.submitted_by_name,su.name,d.submitted_by_username,su.username,'—') "submittedByName",
        COALESCE(d.approved_by_name,au.name,d.approved_by_username,au.username,'—') "approvedByName",
        COALESCE(d.posted_by_name,pu.name,d.posted_by_username,pu.username,'—') "postedByName",
        COALESCE(d.voided_by_name,vu.name,d.voided_by_username,vu.username,'—') "voidedByName",
        d.created_at "createdAt",d.submitted_at "submittedAt",d.approved_at "approvedAt",
        d.posted_at "postedAt",d.voided_at "voidedAt"
      FROM stock_documents d
      JOIN warehouses w ON w.id=d.warehouse_id
      LEFT JOIN users u ON u.id=d.created_by
      LEFT JOIN users su ON su.id=d.submitted_by
      LEFT JOIN users au ON au.id=d.approved_by
      LEFT JOIN users pu ON pu.id=d.posted_by
      LEFT JOIN users vu ON vu.id=d.voided_by
      LEFT JOIN production_orders po ON po.id=d.production_order_id
      LEFT JOIN stock_documents original ON original.id=d.original_document_id
      WHERE d.id=$1`, [id]);
    if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在');
    doc.sourceBusiness = doc.productionOrderId ? '生产任务' : doc.documentType === DocumentType.REVERSAL ? '单据冲销' : '库存作业';
    doc.sourceDocumentNo = doc.productionOrderNo || doc.originalDocumentNo || null;
    doc.lines = await this.db.query(`
      SELECT l.id,l.item_id "itemId",i.item_code "itemCode",i.name "itemName",i.item_type "itemType",i.model,i.spec,
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
    doc.stockCheckLines = doc.documentType === DocumentType.STOCK_CHECK ? await this.db.query(`SELECT c.id,c.location_id "locationId",l.code "locationCode",z.code "zoneCode",c.item_id "itemId",i.item_code "itemCode",i.name "itemName",i.model,i.unit,c.batch_id "batchId",b.batch_no "batchNo",c.counted_qty::text "countedQty",c.system_qty_snapshot::text "systemQtySnapshot",c.difference_qty::text "differenceQty",c.notes FROM stock_check_lines c JOIN warehouse_locations l ON l.id=c.location_id JOIN warehouse_zones z ON z.id=l.zone_id JOIN items i ON i.id=c.item_id LEFT JOIN inventory_batches b ON b.id=c.batch_id WHERE c.document_id=$1 ORDER BY l.code,i.item_code,b.batch_no NULLS FIRST`,[id]) : [];
    doc.receiptAllocations = await this.db.query(`SELECT a.document_line_id "documentLineId",a.disposition,a.warehouse_id "warehouseId",w.warehouse_code "warehouseCode",a.location_id "locationId",l.code "locationCode",a.batch_id "batchId",a.quantity,a.defect_reason "defectReason" FROM stock_document_receipt_allocations a JOIN stock_document_lines dl ON dl.id=a.document_line_id JOIN warehouses w ON w.id=a.warehouse_id JOIN warehouse_locations l ON l.id=a.location_id WHERE dl.document_id=$1 ORDER BY a.id`, [id]);
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

  async list(q: any, user?: AuthUser) {
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
    const allowedWarehouseIds = await this.warehouseAccess.managedWarehouseIds(user);
    if (allowedWarehouseIds !== null) {
      params.push(allowedWarehouseIds);
      where.push(`(d.warehouse_id=ANY($${params.length}::uuid[]) OR EXISTS(SELECT 1 FROM stock_document_lines scoped_line WHERE scoped_line.document_id=d.id AND scoped_line.target_warehouse_id=ANY($${params.length}::uuid[])))`);
    }
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

  async exportCsv(q: any, user?: AuthUser) {
    const first = await this.list({ ...q, page:1, pageSize:100 }, user); const rows = [...first.items];
    for (let page=2; page<=Math.ceil(first.total/100); page++) rows.push(...(await this.list({ ...q, page, pageSize:100 }, user)).items);
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g,'""')}"`;
    return '\uFEFF'+[
      ['单号','类型','状态','来源业务','来源单号','仓库','创建人','创建时间','过账人','过账时间'],
      ...rows.map((row:any)=>[row.documentNo,row.documentType,row.status,row.sourceBusiness,row.sourceDocumentNo,row.warehouseCode,row.createdByName,row.createdAt,row.postedByName,row.postedAt]),
    ].map(row=>row.map(escape).join(',')).join('\r\n');
  }

  private async assertDocumentView(documentId: string, user: AuthUser) {
    if (this.warehouseAccess.isGlobal(user)) return;
    const ids = await this.warehouseAccess.managedWarehouseIds(user) || [];
    const [row] = await this.db.query(`SELECT 1 FROM stock_documents d WHERE d.id=$1 AND (d.warehouse_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM stock_document_lines l WHERE l.document_id=d.id AND l.target_warehouse_id=ANY($2::uuid[])))`, [documentId, ids]);
    if (!row) throw new BusinessException('FORBIDDEN', '当前账号无权查看该仓库单据');
  }

  private async assertDocumentOperation(qr: QueryRunner, documentId: string, user: AuthUser, sourceWarehouseId?: string) {
    const targets = await qr.query(`SELECT DISTINCT target_warehouse_id "warehouseId" FROM stock_document_lines WHERE document_id=$1 AND target_warehouse_id IS NOT NULL`, [documentId]);
    await this.warehouseAccess.assertWarehouses(user, [sourceWarehouseId, ...targets.map((row: any) => row.warehouseId)]);
  }
}
