import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { QueryRunner } from 'typeorm';
import { BusinessException } from '../common/business.exception';

@Injectable()
export class StockReservationService {
  async reserveDocument(qr: QueryRunner, documentId: string) {
    await this.releaseDocument(qr, documentId);
    const lines = await qr.query(
      `SELECT l.id,l.item_id,l.location_id,l.batch_id,l.quantity,
        COALESCE(l.source_warehouse_id,d.warehouse_id) warehouse_id,
        i.item_code,i.name item_name
       FROM stock_document_lines l
       JOIN stock_documents d ON d.id=l.document_id
       JOIN items i ON i.id=l.item_id
       WHERE l.document_id=$1 AND l.direction='OUT'
       ORDER BY COALESCE(l.source_warehouse_id,d.warehouse_id),l.location_id,l.item_id,l.batch_id NULLS FIRST,l.id`,
      [documentId],
    );
    for (const line of lines) {
      const [balance] = await qr.query(
        `SELECT id,on_hand_qty,COALESCE(frozen_qty,0) frozen_qty
         FROM stock_balances
         WHERE warehouse_id=$1 AND location_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4
         FOR UPDATE`,
        [line.warehouse_id, line.location_id, line.item_id, line.batch_id],
      );
      const [{ reserved }] = await qr.query(
        `SELECT COALESCE(sum(quantity),0) reserved FROM stock_reservations
         WHERE warehouse_id=$1 AND location_id=$2 AND item_id=$3
           AND batch_id IS NOT DISTINCT FROM $4 AND status='ACTIVE'`,
        [line.warehouse_id, line.location_id, line.item_id, line.batch_id],
      );
      const available = new Decimal(balance?.on_hand_qty || 0).sub(balance?.frozen_qty || 0).sub(reserved || 0);
      if (available.lt(line.quantity)) {
        throw new BusinessException(
          'INSUFFICIENT_STOCK',
          `${line.item_code} ${line.item_name} 可用库存不足：可用 ${available.toFixed(0)}，申请 ${new Decimal(line.quantity).toFixed(0)}`,
          HttpStatus.CONFLICT,
          { itemId: line.item_id, locationId: line.location_id, availableQty: available.toFixed(0), requestQty: line.quantity },
        );
      }
      await qr.query(
        `INSERT INTO stock_reservations(document_id,document_line_id,warehouse_id,location_id,item_id,batch_id,quantity)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(document_line_id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,location_id=EXCLUDED.location_id,
           item_id=EXCLUDED.item_id,batch_id=EXCLUDED.batch_id,quantity=EXCLUDED.quantity,status='ACTIVE',created_at=now(),released_at=NULL`,
        [documentId, line.id, line.warehouse_id, line.location_id, line.item_id, line.batch_id, line.quantity],
      );
    }
    await this.reserveIncomingCapacity(qr, documentId);
  }

  /** Rebuilds target capacity holds from the document's current receipt allocations. */
  async reserveIncomingCapacity(qr: QueryRunner, documentId: string) {
    await qr.query(`UPDATE location_capacity_reservations SET status='RELEASED',released_at=now() WHERE document_id=$1 AND status='ACTIVE'`, [documentId]);
    const [document] = await qr.query(`SELECT document_type FROM stock_documents WHERE id=$1 FOR UPDATE`, [documentId]);
    if (!document) return;
    const receiptTypes = ['MATERIAL_INBOUND', 'FINISHED_INBOUND', 'PRODUCTION_RETURN', 'PRODUCTION_COMPLETION'];
    let targets: any[] = [];
    if (document.document_type === 'STOCK_MOVE') {
      targets = await qr.query(`SELECT l.id "lineId",NULL::uuid "allocationId",l.target_warehouse_id "warehouseId",l.target_location_id "locationId",l.item_id "itemId",l.quantity
        FROM stock_document_lines l WHERE l.document_id=$1 AND l.target_warehouse_id IS NOT NULL AND l.target_location_id IS NOT NULL`, [documentId]);
    } else if (receiptTypes.includes(document.document_type)) {
      const allocations = await qr.query(`SELECT a.document_line_id "lineId",a.id "allocationId",a.warehouse_id "warehouseId",a.location_id "locationId",l.item_id "itemId",a.quantity
        FROM stock_document_receipt_allocations a JOIN stock_document_lines l ON l.id=a.document_line_id WHERE l.document_id=$1`, [documentId]);
      targets = allocations.length ? allocations : await qr.query(`SELECT l.id "lineId",NULL::uuid "allocationId",COALESCE(l.target_warehouse_id,l.source_warehouse_id,d.warehouse_id) "warehouseId",COALESCE(l.target_location_id,l.location_id) "locationId",l.item_id "itemId",l.quantity
        FROM stock_document_lines l JOIN stock_documents d ON d.id=l.document_id WHERE l.document_id=$1 AND l.direction='IN'`, [documentId]);
    }
    const grouped = new Map<string, any>();
    for (const target of targets) {
      if (!target.locationId || !target.warehouseId) continue;
      const key = `${target.lineId}:${target.locationId}`;
      const current = grouped.get(key) || { ...target, quantity: new Decimal(0) };
      current.quantity = current.quantity.add(target.quantity || 0);
      grouped.set(key, current);
    }
    for (const target of grouped.values()) await this.holdIncomingCapacity(qr, documentId, target);
  }

  private async holdIncomingCapacity(qr: QueryRunner, documentId: string, target: any) {
    const [location] = await qr.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND status='ACTIVE' AND is_archived=false FOR UPDATE`, [target.locationId, target.warehouseId]);
    if (!location) throw new BusinessException('VALIDATION_ERROR', '目标仓库或库位不可用');
    const [capacity] = await qr.query(`SELECT capacity FROM location_item_capacities WHERE location_id=$1 AND item_id=$2 FOR UPDATE`, [target.locationId, target.itemId]);
    if (capacity) {
      const [stock] = await qr.query(`SELECT COALESCE(sum(on_hand_qty),0)::text quantity FROM stock_balances WHERE location_id=$1 AND item_id=$2`, [target.locationId, target.itemId]);
      const [held] = await qr.query(`SELECT COALESCE(sum(quantity),0)::text quantity FROM location_capacity_reservations WHERE location_id=$1 AND item_id=$2 AND status='ACTIVE'`, [target.locationId, target.itemId]);
      const after = new Decimal(stock?.quantity || 0).add(held?.quantity || 0).add(target.quantity || 0);
      if (after.gt(capacity.capacity)) throw new BusinessException('LOCATION_CAPACITY_EXCEEDED', '目标库位的该物料容量不足，请选择其他库位或拆分数量', HttpStatus.CONFLICT, { locationId: target.locationId, capacityQty: new Decimal(capacity.capacity).toFixed(0), remainingCapacityQty: Decimal.max(new Decimal(capacity.capacity).sub(stock?.quantity || 0).sub(held?.quantity || 0), 0).toFixed(0), requestQty: target.quantity.toFixed(0) });
    }
    await qr.query(`INSERT INTO location_capacity_reservations(document_id,document_line_id,receipt_allocation_id,warehouse_id,location_id,item_id,quantity) VALUES($1,$2,$3,$4,$5,$6,$7)`, [documentId, target.lineId, target.allocationId || null, target.warehouseId, target.locationId, target.itemId, target.quantity.toFixed(0)]);
  }

  async releaseDocument(qr: QueryRunner, documentId: string) {
    await qr.query(
      `UPDATE stock_reservations SET status='RELEASED',released_at=now()
       WHERE document_id=$1 AND status='ACTIVE'`,
      [documentId],
    );
    await qr.query(`UPDATE location_capacity_reservations SET status='RELEASED',released_at=now() WHERE document_id=$1 AND status='ACTIVE'`, [documentId]);
  }

  async consumeDocument(qr: QueryRunner, documentId: string) {
    await qr.query(
      `UPDATE stock_reservations SET status='CONSUMED',released_at=now()
       WHERE document_id=$1 AND status='ACTIVE'`,
      [documentId],
    );
    await qr.query(`UPDATE location_capacity_reservations SET status='CONSUMED',released_at=now() WHERE document_id=$1 AND status='ACTIVE'`, [documentId]);
  }
}
