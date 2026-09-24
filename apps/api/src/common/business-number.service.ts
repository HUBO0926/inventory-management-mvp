import { Injectable } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { BusinessException } from './business.exception';
import { DocumentType } from './constants';

export const DOCUMENT_NUMBER_PREFIX: Record<DocumentType, string> = {
  [DocumentType.MATERIAL_INBOUND]: 'YCLRK',
  [DocumentType.FINISHED_INBOUND]: 'CPRK',
  [DocumentType.FINISHED_OUTBOUND]: 'CPCK',
  [DocumentType.INVENTORY_ADJUSTMENT]: 'KCTZ',
  [DocumentType.PRODUCTION_ISSUE]: 'SCLL',
  [DocumentType.PRODUCTION_RETURN]: 'SCTL',
  [DocumentType.PRODUCTION_COMPLETION]: 'WGBP',
  [DocumentType.STOCK_MOVE]: 'YK',
  [DocumentType.STOCK_CHECK]: 'KCPD',
  [DocumentType.DEFECTIVE_RETURN]: 'BLTH',
  [DocumentType.DEFECTIVE_REPAIR_RESTOCK]: 'BLFX',
  [DocumentType.DEFECTIVE_PRODUCTION_RETURN]: 'BLFS',
  [DocumentType.REVERSAL]: 'CX',
};

/** Inventory ledger numbers are independent from document numbers. */
export const STOCK_FLOW_NUMBER_PREFIX: Record<DocumentType, string> = {
  [DocumentType.FINISHED_INBOUND]: 'CPRK',
  [DocumentType.PRODUCTION_COMPLETION]: 'CPRK',
  [DocumentType.MATERIAL_INBOUND]: 'YLRK',
  [DocumentType.PRODUCTION_RETURN]: 'YLRK',
  [DocumentType.FINISHED_OUTBOUND]: 'CPCK',
  [DocumentType.PRODUCTION_ISSUE]: 'YLCK',
  [DocumentType.STOCK_MOVE]: 'YK',
  [DocumentType.STOCK_CHECK]: 'PD',
  [DocumentType.INVENTORY_ADJUSTMENT]: 'TZ',
  [DocumentType.DEFECTIVE_RETURN]: 'TZ',
  [DocumentType.DEFECTIVE_REPAIR_RESTOCK]: 'TZ',
  [DocumentType.DEFECTIVE_PRODUCTION_RETURN]: 'TZ',
  [DocumentType.REVERSAL]: 'TZ',
};

type NumberSource = 'stock_documents' | 'production_orders';

@Injectable()
export class BusinessNumberService {
  stockDocument(qr: QueryRunner, type: DocumentType) {
    return this.next(qr, DOCUMENT_NUMBER_PREFIX[type], 'stock_documents');
  }

  productionOrder(qr: QueryRunner) {
    return this.next(qr, 'SCRW', 'production_orders');
  }

  async stockFlow(qr: QueryRunner, type: DocumentType) {
    const prefix = STOCK_FLOW_NUMBER_PREFIX[type];
    if (!prefix) throw new BusinessException('VALIDATION_ERROR', '未配置库存流水业务类型');
    const [clock] = await qr.query(`
      SELECT value::date "flowDate",to_char(value,'YYYYMMDD') "dateStamp"
      FROM (SELECT clock_timestamp() AT TIME ZONE 'Asia/Shanghai' value) clock
    `);
    const [counter] = await qr.query(`
      INSERT INTO stock_transaction_flow_sequences(flow_date,last_sequence)
      VALUES($1,1)
      ON CONFLICT(flow_date) DO UPDATE
        SET last_sequence=stock_transaction_flow_sequences.last_sequence+1,updated_at=now()
      RETURNING last_sequence "sequence"
    `, [clock.flowDate]);
    const sequence = Number(counter?.sequence);
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999999) {
      throw new BusinessException('FLOW_SEQUENCE_EXHAUSTED', '当日库存流水号已达到上限，请联系系统管理员');
    }
    return `LS-${prefix}-${clock.dateStamp}-${String(sequence).padStart(6, '0')}`;
  }

  private async next(qr: QueryRunner, prefix: string | undefined, source: NumberSource) {
    if (!prefix) throw new Error('未配置业务单据编号前缀');
    const [clock] = await qr.query(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYYMMDDHH24MISS') stamp`,
    );
    const base = `${prefix}-${clock.stamp}`;
    await qr.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`business-number:${base}`]);
    const column = source === 'stock_documents' ? 'document_no' : 'order_no';
    const rows: Array<{ number: string }> = await qr.query(
      `SELECT ${column} number FROM ${source} WHERE ${column}=$1 OR ${column} LIKE $2`,
      [base, `${base}-%`],
    );
    if (!rows.length) return base;
    const maxSequence = rows.reduce((max, row) => {
      if (row.number === base) return Math.max(max, 0);
      const suffix = row.number.slice(base.length + 1);
      return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max;
    }, 0);
    return `${base}-${String(maxSequence + 1).padStart(2, '0')}`;
  }
}
