import { Injectable } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

export interface ApprovalContext { requestId?: string; ip?: string; idempotencyKey?: string; reasonCode?: string; reason?: string; source?: string; }

@Injectable()
export class ApprovalHistoryService {
  async record(qr: QueryRunner, documentId: string, action: string, before: string, after: string, actorId: string | undefined, context: ApprovalContext = {}) {
    const [doc] = await qr.query(`SELECT id,document_no,document_type,warehouse_id,production_order_id,notes FROM stock_documents WHERE id=$1`, [documentId]);
    if (!doc) return;
    const [actor] = actorId ? await qr.query(`SELECT username,name FROM users WHERE id=$1`, [actorId]) : [];
    await qr.query(`INSERT INTO approval_records(document_id,document_no,document_type,action,status_before,status_after,actor_user_id,actor_username,actor_name,reason_code,reason,idempotency_key,request_id,ip,payload,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`, [
      documentId, doc.document_no, doc.document_type, action, before, after, actorId || null,
      actor?.username || null, actor?.name || null, context.reasonCode || null, context.reason || null,
      context.idempotencyKey || null, context.requestId || null, context.ip || null,
      JSON.stringify({ warehouseId: doc.warehouse_id, productionOrderId: doc.production_order_id, notes: doc.notes }), context.source || 'SYSTEM',
    ]);
  }
}
