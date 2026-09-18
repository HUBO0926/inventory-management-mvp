import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { BusinessException } from '../common/business.exception';
import { BusinessNumberService } from '../common/business-number.service';
import { Direction, DocumentType } from '../common/constants';
import { snapshotUser } from '../common/snapshot';
import type { AuthUser } from '../common/constants';
import { StockReservationService } from './reservation.service';
import { WarehouseManagementService } from '../warehouses/warehouse-management.service';

export interface DocumentLineInput { itemId: string; quantity: string; direction: Direction; sourceWarehouseId?: string; locationId?: string; batchId?: string; targetWarehouseId?: string; targetLocationId?: string; targetBatchId?: string; normalQty?: string; spareQty?: string; notes?: string; }
export interface NewDocumentInput { documentType: DocumentType; warehouseId: string; productionOrderId?: string; originalDocumentId?: string; notes?: string; lines: DocumentLineInput[]; operator?: AuthUser; }
export const stableHash = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

@Injectable()
export class InventoryPostingService {
  constructor(private readonly db: DataSource, private readonly audit: AuditService, private readonly reservations: StockReservationService, private readonly numbers: BusinessNumberService, @Optional() private readonly operations?: WarehouseManagementService) {}

  async executeIdempotent<T>(userId: string, key: string | undefined, endpoint: string, payload: unknown, work: (qr: QueryRunner) => Promise<T>): Promise<T> {
    if (!key?.trim()) throw new BusinessException('VALIDATION_ERROR', '缺少 Idempotency-Key 请求头');
    if (key.length > 100) throw new BusinessException('VALIDATION_ERROR', 'Idempotency-Key 长度不能超过 100');
    const hash = stableHash(payload), qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const inserted = await qr.query(`INSERT INTO idempotency_keys(id,user_id,idempotency_key,endpoint,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), userId, key, endpoint, hash]);
      if (!inserted.length) { const [existing] = await qr.query(`SELECT request_hash,response_payload FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 AND endpoint=$3 FOR UPDATE`, [userId, key, endpoint]); if (!existing || existing.request_hash !== hash) throw new BusinessException('IDEMPOTENCY_CONFLICT', '相同幂等键对应不同请求内容', HttpStatus.CONFLICT); if (existing.response_payload === null) throw new BusinessException('IDEMPOTENCY_CONFLICT', '相同请求正在处理中', HttpStatus.CONFLICT); await qr.commitTransaction(); return existing.response_payload as T; }
      const result = await work(qr); await qr.query(`UPDATE idempotency_keys SET response_payload=$1 WHERE user_id=$2 AND idempotency_key=$3 AND endpoint=$4`, [JSON.stringify(result), userId, key, endpoint]); await qr.commitTransaction(); return result;
    } catch (error) { if (qr.isTransactionActive) await qr.rollbackTransaction(); throw error; } finally { await qr.release(); }
  }

  async createDocument(qr: QueryRunner, input: NewDocumentInput, userId: string) {
    if (!input.lines.length) throw new BusinessException('VALIDATION_ERROR', '单据至少包含一条明细');
    const dimensions = input.lines.map(line => input.documentType === DocumentType.STOCK_MOVE
      ? `${line.sourceWarehouseId || input.warehouseId}:${line.itemId}:${line.locationId || ''}:${line.batchId || ''}:${line.targetWarehouseId || ''}:${line.targetLocationId || ''}:${line.targetBatchId || ''}`
      : `${line.sourceWarehouseId || input.warehouseId}:${line.itemId}:${line.locationId || ''}:${line.batchId || ''}`);
    if (new Set(dimensions).size !== dimensions.length) throw new BusinessException('VALIDATION_ERROR', '同一物料、库位和批次组合不能重复');
    const id = randomUUID();
    const snap = snapshotUser(input.operator);
    const documentNo = await this.insertDocumentHeader(qr, id, input, userId, snap);
    for (const line of input.lines) {
      const sourceWarehouseId = line.sourceWarehouseId || input.warehouseId;
      let locationId = line.locationId; if (!locationId) { const [location] = await qr.query(`SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND status='ACTIVE' ORDER BY code LIMIT 1`, [sourceWarehouseId]); locationId = location?.id; }
      if (!locationId) throw new BusinessException('VALIDATION_ERROR', '仓库没有可用库位');
      const [item] = await qr.query(`SELECT item_code,name,model,spec,unit FROM items WHERE id=$1`, [line.itemId]);
      await qr.query(`INSERT INTO stock_document_lines(id,document_id,item_id,quantity,direction,source_warehouse_id,location_id,batch_id,target_warehouse_id,target_location_id,target_batch_id,normal_qty,spare_qty,notes,material_snapshot) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, line.itemId, line.quantity, line.direction, sourceWarehouseId, locationId, line.batchId || null, line.targetWarehouseId || null, line.targetLocationId || null, line.targetBatchId || null, line.normalQty || (input.documentType === DocumentType.PRODUCTION_ISSUE ? line.quantity : '0'), line.spareQty || '0', line.notes || null, item ? JSON.stringify(item) : null]);
    }
    return { id, documentNo };
  }

  async createStockCheckDocument(qr: QueryRunner, input: { warehouseId: string; notes?: string; lines: Array<{ locationId: string; itemId: string; batchId?: string; countedQty: string; notes?: string }>; operator: AuthUser }, userId: string) {
    if (!input.lines.length) throw new BusinessException('VALIDATION_ERROR', '盘点单至少包含一条明细');
    const dimensions = input.lines.map(line => `${line.locationId}:${line.itemId}:${line.batchId || ''}`);
    if (new Set(dimensions).size !== dimensions.length) throw new BusinessException('VALIDATION_ERROR', '盘点明细的库位、物料和批次不能重复');
    const id = randomUUID();
    const documentNo = await this.insertDocumentHeader(qr, id, { documentType: DocumentType.STOCK_CHECK, warehouseId: input.warehouseId, notes: input.notes, lines: [], operator: input.operator }, userId, snapshotUser(input.operator));
    for (const line of input.lines) {
      const counted = new Decimal(line.countedQty);
      if (!counted.isInteger() || counted.isNegative()) throw new BusinessException('VALIDATION_ERROR', '实盘数量必须是非负整数');
      await qr.query(`INSERT INTO stock_check_lines(document_id,warehouse_id,location_id,item_id,batch_id,counted_qty,notes) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id,input.warehouseId,line.locationId,line.itemId,line.batchId||null,counted.toFixed(0),line.notes||null]);
    }
    return { id, documentNo };
  }

  private async insertDocumentHeader(qr: QueryRunner, id: string, input: NewDocumentInput, userId: string, snap: ReturnType<typeof snapshotUser>) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const documentNo = await this.numbers.stockDocument(qr, input.documentType);
      await qr.query('SAVEPOINT business_number_insert');
      try {
        await qr.query(`INSERT INTO stock_documents(id,document_no,document_type,status,warehouse_id,production_order_id,original_document_id,notes,created_by,created_by_user_id,created_by_username,created_by_name,created_by_department) VALUES($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, documentNo, input.documentType, input.warehouseId, input.productionOrderId || null, input.originalDocumentId || null, input.notes || null, userId, snap.userId, snap.username, snap.name, snap.department]);
        await qr.query('RELEASE SAVEPOINT business_number_insert');
        return documentNo;
      } catch (error: any) {
        await qr.query('ROLLBACK TO SAVEPOINT business_number_insert');
        await qr.query('RELEASE SAVEPOINT business_number_insert');
        if (error?.code !== '23505' || attempt === 1) throw error;
      }
    }
    throw new Error('业务单据编号生成失败');
  }

  async applyDocument(qr: QueryRunner, documentId: string, userId: string, allowedStatuses = ['SUBMITTED']) {
    const [doc] = await qr.query(`SELECT d.*,w.warehouse_code,w.warehouse_type FROM stock_documents d JOIN warehouses w ON w.id=d.warehouse_id WHERE d.id=$1 FOR UPDATE`, [documentId]);
    if (!doc) throw new BusinessException('NOT_FOUND', '库存单据不存在'); if (!allowedStatuses.includes(doc.status)) throw new BusinessException('INVALID_STATUS', '当前单据状态不能过账');
    if (doc.document_type === DocumentType.STOCK_CHECK) return this.applyStockCheck(qr, doc, userId);
    const lines = await qr.query(`SELECT l.*,i.item_code,i.name item_name,i.item_type,i.status item_status,loc.warehouse_id location_warehouse_id,b.item_id batch_item_id,wsrc.warehouse_type source_warehouse_type FROM stock_document_lines l JOIN items i ON i.id=l.item_id JOIN warehouse_locations loc ON loc.id=l.location_id LEFT JOIN warehouses wsrc ON wsrc.id=COALESCE(l.source_warehouse_id,loc.warehouse_id) LEFT JOIN inventory_batches b ON b.id=l.batch_id WHERE l.document_id=$1 ORDER BY COALESCE(l.source_warehouse_id,loc.warehouse_id),l.location_id,l.item_id,l.batch_id NULLS FIRST`, [documentId]);
    if (!lines.length) throw new BusinessException('VALIDATION_ERROR', '单据没有明细'); this.validateWarehouseAndItems(doc, lines);
    await this.operations?.assertOperationAllowed(qr, lines.flatMap((line: any) => [line.location_id,line.target_location_id]), lines.flatMap((line: any) => line.target_location_id ? [{ locationId: line.target_location_id,itemId: line.item_id }] : line.direction===Direction.IN ? [{ locationId: line.location_id,itemId: line.item_id }] : []));
    const postedLines: any[] = [];
    if ([DocumentType.STOCK_MOVE, DocumentType.DEFECTIVE_REPAIR_RESTOCK].includes(doc.document_type)) {
      for (const line of lines) {
        if (line.location_warehouse_id !== doc.warehouse_id || !line.target_warehouse_id || !line.target_location_id) throw new BusinessException('VALIDATION_ERROR', '移库来源或目标不完整');
        const [target] = await qr.query(`SELECT l.warehouse_id,b.item_id batch_item_id FROM warehouse_locations l LEFT JOIN inventory_batches b ON b.id=$2 WHERE l.id=$1 AND l.status='ACTIVE'`, [line.target_location_id, line.target_batch_id || line.batch_id]);
        if (!target || target.warehouse_id !== line.target_warehouse_id || (target.batch_item_id && target.batch_item_id !== line.item_id)) throw new BusinessException('VALIDATION_ERROR', '移库目标仓库、库位或批次无效');
        postedLines.push(await this.postLine(qr, documentId, userId, line, doc.warehouse_id, line.location_id, line.batch_id, Direction.OUT));
        postedLines.push(await this.postLine(qr, documentId, userId, line, line.target_warehouse_id, line.target_location_id, line.target_batch_id || line.batch_id, Direction.IN));
      }
    } else if (doc.document_type === DocumentType.REVERSAL) {
      for (const line of lines) postedLines.push(await this.postLine(qr, documentId, userId, line, line.target_warehouse_id || doc.warehouse_id, line.location_id, line.batch_id, line.direction));
    } else {
      const allocations = [DocumentType.MATERIAL_INBOUND, DocumentType.FINISHED_INBOUND, DocumentType.PRODUCTION_RETURN, DocumentType.PRODUCTION_COMPLETION].includes(doc.document_type) ? await qr.query(`SELECT a.*,l.item_id FROM stock_document_receipt_allocations a JOIN stock_document_lines l ON l.id=a.document_line_id WHERE l.document_id=$1 ORDER BY a.warehouse_id,a.location_id,a.id`, [documentId]) : [];
      if (allocations.length) {
        for (const line of lines) {
          const rows = allocations.filter((row: any) => row.document_line_id === line.id); const total = rows.reduce((sum: Decimal, row: any) => sum.add(row.quantity), new Decimal(0));
          if (!rows.length || !total.eq(line.quantity)) throw new BusinessException('VALIDATION_ERROR', `${line.item_code} 的审核分配数量必须等于送审数量`);
          for (const row of rows) {
            const [target] = await qr.query(`SELECT w.warehouse_type FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=$1 AND l.warehouse_id=$2 AND l.status='ACTIVE' AND l.is_archived=false AND w.status='ACTIVE' AND w.deleted_at IS NULL`, [row.location_id, row.warehouse_id]);
            const normalType = line.item_type === 'MATERIAL' ? 'RAW' : 'FG';
            if (!target || (row.disposition === 'NORMAL' && target.warehouse_type !== normalType) || (row.disposition === 'DEFECTIVE' && target.warehouse_type !== 'DEFECTIVE')) throw new BusinessException('VALIDATION_ERROR', '审核分配的仓库或库位不符合入库规则');
            postedLines.push(await this.postLine(qr, documentId, userId, { ...line, quantity: row.quantity }, row.warehouse_id, row.location_id, row.batch_id || line.batch_id, Direction.IN));
            if (row.disposition === 'DEFECTIVE') await qr.query(`INSERT INTO defective_inventory_lots(source_allocation_id,source_document_id,source_document_line_id,item_id,warehouse_id,location_id,batch_id,production_order_id,defect_reason,received_qty,remaining_qty)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [row.id,documentId,line.id,line.item_id,row.warehouse_id,row.location_id,row.batch_id||line.batch_id,doc.production_order_id,row.defect_reason,row.quantity]);
          }
        }
      } else for (const line of lines) { const sourceWarehouseId = line.source_warehouse_id || doc.warehouse_id; if (line.location_warehouse_id !== sourceWarehouseId || (line.batch_id && line.batch_item_id !== line.item_id)) throw new BusinessException('VALIDATION_ERROR', '库位、仓库或批次不属于单据明细'); postedLines.push(await this.postLine(qr, documentId, userId, line, sourceWarehouseId, line.location_id, line.batch_id, line.direction)); }
    }
    await this.reservations.consumeDocument(qr, documentId);
    await this.operations?.refreshInventoryAlerts(qr,[doc.warehouse_id,...lines.map((line:any)=>line.target_warehouse_id).filter(Boolean)]);
    await qr.query(`UPDATE stock_documents SET status='POSTED',
      posted_by=$1,posted_by_user_id=$1,posted_by_username=(SELECT username FROM users WHERE id=$1),posted_by_name=(SELECT name FROM users WHERE id=$1),posted_at=now(),
      approved_by=$1,approved_by_user_id=$1,approved_by_username=(SELECT username FROM users WHERE id=$1),approved_by_name=(SELECT name FROM users WHERE id=$1),approved_at=now(),
      updated_at=now() WHERE id=$2`, [userId, documentId]);
    await this.audit.log(userId, 'POST_STOCK_DOCUMENT', 'stock_documents', documentId, { documentType: doc.document_type, lines: postedLines }, qr.manager);
    return { id: documentId, documentNo: doc.document_no, documentType: doc.document_type, status: 'POSTED', lines: postedLines };
  }

  private async postLine(qr: QueryRunner, documentId: string, userId: string, line: any, warehouseId: string, locationId: string, batchId: string | null, direction: Direction) {
    await this.operations?.assertOperationAllowed(qr, [locationId], direction===Direction.IN ? [{ locationId, itemId: line.item_id }] : []);
    if (direction === Direction.IN) await this.assertLocationItemCapacity(qr, documentId, locationId, line.item_id, line.quantity);
    await qr.query(`INSERT INTO stock_balances(id,warehouse_id,location_id,item_id,batch_id,on_hand_qty) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT(warehouse_id,location_id,item_id,batch_id) DO NOTHING`, [randomUUID(), warehouseId, locationId, line.item_id, batchId]);
    const [balance] = await qr.query(`SELECT id,on_hand_qty FROM stock_balances WHERE warehouse_id=$1 AND location_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4 FOR UPDATE`, [warehouseId, locationId, line.item_id, batchId]);
    const delta = new Decimal(line.quantity).mul(direction === Direction.IN ? 1 : -1), after = new Decimal(balance.on_hand_qty).add(delta); if (after.isNegative()) throw new BusinessException('INSUFFICIENT_STOCK', `${line.item_code} ${line.item_name} 库存不足：可用 ${balance.on_hand_qty}，本次 ${line.quantity}`, HttpStatus.CONFLICT, { itemId: line.item_id, itemCode: line.item_code, availableQty: balance.on_hand_qty, requestQty: line.quantity });
    const value = after.toFixed(0); await qr.query(`UPDATE stock_balances SET on_hand_qty=$1,version=version+1,updated_at=now() WHERE id=$2`, [value, balance.id]);
    const [operator] = await qr.query(`SELECT username,COALESCE(employee_name,name,username) name,department FROM users WHERE id=$1`, [userId]);
    await qr.query(`INSERT INTO stock_transactions(id,source_document_id,warehouse_id,location_id,item_id,batch_id,balance_before,delta_qty,balance_after,created_by,operator_username,operator_name,operator_department) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [randomUUID(), documentId, warehouseId, locationId, line.item_id, batchId, balance.on_hand_qty, delta.toFixed(0), value, userId,operator?.username||null,operator?.name||null,operator?.department||null]);
    return { itemId: line.item_id, itemCode: line.item_code, locationId, batchId, quantity: new Decimal(line.quantity).toFixed(0), direction, balanceBefore: balance.on_hand_qty, balanceAfter: value };
  }

  private async applyStockCheck(qr: QueryRunner, doc: any, userId: string) {
    const lines = await qr.query(`SELECT c.*,i.item_code,i.name item_name FROM stock_check_lines c JOIN items i ON i.id=c.item_id WHERE c.document_id=$1 ORDER BY c.location_id,c.item_id,c.batch_id NULLS FIRST`, [doc.id]);
    if (!lines.length) throw new BusinessException('VALIDATION_ERROR', '盘点单没有明细');
    await this.operations?.assertOperationAllowed(qr, lines.map((line: any) => line.location_id));
    const postedLines: any[] = [];
    for (const line of lines) {
      await qr.query(`INSERT INTO stock_balances(id,warehouse_id,location_id,item_id,batch_id,on_hand_qty) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT(warehouse_id,location_id,item_id,batch_id) DO NOTHING`, [randomUUID(),line.warehouse_id,line.location_id,line.item_id,line.batch_id]);
      const [balance] = await qr.query(`SELECT on_hand_qty FROM stock_balances WHERE warehouse_id=$1 AND location_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4 FOR UPDATE`, [line.warehouse_id,line.location_id,line.item_id,line.batch_id]);
      if (line.system_qty_snapshot === null || !new Decimal(balance.on_hand_qty).eq(line.system_qty_snapshot)) throw new BusinessException('STOCK_CHECK_SNAPSHOT_CONFLICT', `${line.item_code} 的账面库存已变化，请重新盘点后提交`, HttpStatus.CONFLICT, { itemId: line.item_id, locationId: line.location_id, snapshotQty: line.system_qty_snapshot, currentQty: balance.on_hand_qty });
      const difference = new Decimal(line.counted_qty).sub(balance.on_hand_qty);
      if (!difference.isZero()) postedLines.push(await this.postLine(qr, doc.id, userId, { ...line, quantity: difference.abs().toFixed(0) }, line.warehouse_id, line.location_id, line.batch_id, difference.isPositive() ? Direction.IN : Direction.OUT));
    }
    await this.operations?.refreshInventoryAlerts(qr,[doc.warehouse_id]);
    await qr.query(`UPDATE stock_documents SET status='POSTED',posted_by=$1,posted_by_user_id=$1,posted_by_username=(SELECT username FROM users WHERE id=$1),posted_by_name=(SELECT COALESCE(employee_name,name) FROM users WHERE id=$1),posted_at=now(),approved_by=$1,approved_by_user_id=$1,approved_by_username=(SELECT username FROM users WHERE id=$1),approved_by_name=(SELECT COALESCE(employee_name,name) FROM users WHERE id=$1),approved_at=now(),updated_at=now() WHERE id=$2`, [userId,doc.id]);
    await this.audit.log(userId,'POST_STOCK_CHECK','stock_documents',doc.id,{ lines: postedLines },qr.manager);
    return { id: doc.id,documentNo: doc.document_no,documentType: DocumentType.STOCK_CHECK,status:'POSTED',lines:postedLines };
  }

  private async assertLocationItemCapacity(qr: QueryRunner, documentId: string, locationId: string, itemId: string, quantity: string) {
    const [capacity] = await qr.query(
      `SELECT capacity FROM location_item_capacities WHERE location_id=$1 AND item_id=$2 FOR UPDATE`,
      [locationId, itemId],
    );
    if (!capacity) return;
    const [stock] = await qr.query(
      `SELECT COALESCE(sum(on_hand_qty),0)::text quantity FROM stock_balances WHERE location_id=$1 AND item_id=$2`,
      [locationId, itemId],
    );
    const [held] = await qr.query(`SELECT COALESCE(sum(quantity),0)::text quantity FROM location_capacity_reservations WHERE location_id=$1 AND item_id=$2 AND status='ACTIVE' AND document_id<>$3`, [locationId, itemId, documentId]);
    const after = new Decimal(stock?.quantity || 0).add(held?.quantity || 0).add(quantity || 0);
    if (after.gt(capacity.capacity)) {
      throw new BusinessException('LOCATION_CAPACITY_EXCEEDED', '目标库位的该物料容量不足，请选择其他库位或拆分数量', HttpStatus.CONFLICT, {
        locationId,
        capacityQty: new Decimal(capacity.capacity).toFixed(0),
        onHandQty: new Decimal(stock?.quantity || 0).toFixed(0),
        reservedCapacityQty: new Decimal(held?.quantity || 0).toFixed(0),
        requestQty: new Decimal(quantity || 0).toFixed(0),
      });
    }
  }

  private validateWarehouseAndItems(doc: any, lines: any[]) {
    if ([DocumentType.REVERSAL, DocumentType.INVENTORY_ADJUSTMENT, DocumentType.STOCK_MOVE].includes(doc.document_type)) return;
    if ([DocumentType.DEFECTIVE_RETURN,DocumentType.DEFECTIVE_REPAIR_RESTOCK,DocumentType.DEFECTIVE_PRODUCTION_RETURN].includes(doc.document_type)) {
      if (lines.some(line => line.source_warehouse_type !== 'DEFECTIVE')) throw new BusinessException('VALIDATION_ERROR','不良品处理只能从不良品库出库');
      return;
    }
    const warehouseType = doc.warehouse_type || doc.warehouse_code;
    if (doc.document_type === DocumentType.MATERIAL_INBOUND) { if (warehouseType !== 'RAW' || lines.some(line => line.item_type !== 'MATERIAL')) throw new BusinessException('VALIDATION_ERROR', '原材料入库必须使用原材料仓库且只能包含原材料'); return; }
    if ([DocumentType.PRODUCTION_ISSUE, DocumentType.PRODUCTION_RETURN].includes(doc.document_type)) { if (lines.some(line => line.source_warehouse_type !== 'RAW' || line.item_type !== 'MATERIAL')) throw new BusinessException('VALIDATION_ERROR', '生产领退料必须从启用的原材料仓库处理原材料'); return; }
    if (doc.document_type === DocumentType.PRODUCTION_COMPLETION) { if (warehouseType !== 'FG' || lines.some(line => line.item_type !== 'FINISHED_GOOD')) throw new BusinessException('VALIDATION_ERROR', '完工入库只能包含成品且送审意向仓库必须是成品仓库'); return; }
    if ([DocumentType.FINISHED_INBOUND, DocumentType.FINISHED_OUTBOUND].includes(doc.document_type)) { if (lines.some(line => line.item_status !== 'ACTIVE')) throw new BusinessException('VALIDATION_ERROR', '成品入出库只能包含启用物料'); if (warehouseType !== 'FG' || lines.some(line => line.item_type !== 'FINISHED_GOOD')) throw new BusinessException('VALIDATION_ERROR', '成品入出库必须使用成品仓库且只能包含成品'); }
  }
}
