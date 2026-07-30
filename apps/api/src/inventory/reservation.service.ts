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
  }

  async releaseDocument(qr: QueryRunner, documentId: string) {
    await qr.query(
      `UPDATE stock_reservations SET status='RELEASED',released_at=now()
       WHERE document_id=$1 AND status='ACTIVE'`,
      [documentId],
    );
  }

  async consumeDocument(qr: QueryRunner, documentId: string) {
    await qr.query(
      `UPDATE stock_reservations SET status='CONSUMED',released_at=now()
       WHERE document_id=$1 AND status='ACTIVE'`,
      [documentId],
    );
  }
}
