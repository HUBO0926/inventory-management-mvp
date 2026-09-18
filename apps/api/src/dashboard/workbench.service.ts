import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class WorkbenchService {
  constructor(private readonly db: DataSource) {}

  async overview() {
    const [kpi] = await this.db.query(`
      SELECT
        count(*) FILTER (WHERE i.item_type='MATERIAL')::int AS "rawSkuCount",
        count(*) FILTER (WHERE i.item_type='FINISHED_GOOD')::int AS "fgSkuCount",
        coalesce(sum(sb.on_hand_qty),0)::text AS "totalStock",
        count(*) FILTER (WHERE coalesce(sb.on_hand_qty,0)=0)::int AS "zeroStockCount",
        count(*) FILTER (WHERE coalesce(sb.on_hand_qty,0)>0 AND coalesce(sb.on_hand_qty,0)<=i.minimum_stock)::int AS "lowStockCount",
        (SELECT count(*)::int FROM stock_documents WHERE status='SUBMITTED' AND deleted_at IS NULL) AS "pendingReviewCount",
        (SELECT count(*)::int FROM production_orders WHERE status IN ('RELEASED','AWAITING_ISSUE','IN_PROGRESS'))::int AS "activeProductionCount"
      FROM items i
      LEFT JOIN (SELECT item_id,sum(on_hand_qty) on_hand_qty FROM stock_balances GROUP BY item_id) sb ON sb.item_id=i.id
      WHERE i.deleted_at IS NULL AND i.status='ACTIVE'
    `);

    // Recent transactions
    const recentTransactions = await this.db.query(`
      SELECT t.id,t.created_at "createdAt",w.warehouse_code "warehouseCode",
        i.item_code "itemCode",i.name "itemName",d.document_no "documentNo",
        d.document_type "documentType",t.delta_qty "deltaQty",t.balance_after "balanceAfter"
      FROM stock_transactions t
      JOIN items i ON i.id=t.item_id
      JOIN stock_documents d ON d.id=t.source_document_id
      JOIN warehouses w ON w.id=t.warehouse_id
      ORDER BY t.created_at DESC LIMIT 8
    `);

    return { ...kpi, recentTransactions };
  }

  async todos(userId: string) {
    const pendingReview = await this.db.query(
      `SELECT count(*)::int count FROM stock_documents WHERE status='SUBMITTED' AND deleted_at IS NULL`,
    );
    const pendingPutaway = await this.db.query(
      `SELECT count(*)::int count FROM stock_documents WHERE status='APPROVED' AND document_type IN ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_COMPLETION') AND deleted_at IS NULL`,
    );
    const pendingPick = await this.db.query(
      `SELECT count(*)::int count FROM stock_documents WHERE status='APPROVED' AND document_type='FINISHED_OUTBOUND' AND deleted_at IS NULL`,
    );
    const pendingIssue = await this.db.query(
      `SELECT count(*)::int count FROM production_orders WHERE status='AWAITING_ISSUE'`,
    );
    const pendingComplete = await this.db.query(
      `SELECT count(*)::int count FROM production_orders WHERE status='AWAITING_COMPLETION'`,
    );
    const shortageOrders = await this.db.query(
      `SELECT count(*)::int count FROM production_orders WHERE shortage_flag=true AND status IN ('DRAFT','RELEASED')`,
    );

    return {
      pendingReviewCount: Number(pendingReview[0]?.count || 0),
      pendingPutawayCount: Number(pendingPutaway[0]?.count || 0),
      pendingPickCount: Number(pendingPick[0]?.count || 0),
      pendingIssueCount: Number(pendingIssue[0]?.count || 0),
      pendingCompleteCount: Number(pendingComplete[0]?.count || 0),
      shortageOrderCount: Number(shortageOrders[0]?.count || 0),
    };
  }

  async todosAll() {
    const pendingReview = await this.db.query(
      `SELECT d.id,d.document_no "documentNo",d.document_type "documentType",d.created_at "createdAt",
        cu.employee_name "createdByName"
       FROM stock_documents d
       JOIN users cu ON cu.id=d.created_by
       WHERE d.status='SUBMITTED' AND d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 20`,
    );
    return { items: pendingReview };
  }
}
