import { MigrationInterface, QueryRunner } from 'typeorm';

export class IntegerQuantityDefectiveProcessing1860000000000 implements MigrationInterface {
  name = 'IntegerQuantityDefectiveProcessing1860000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_document_type_check`);
    await q.query(`ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_document_type_check CHECK(document_type IN
      ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION',
       'FINISHED_OUTBOUND','INVENTORY_ADJUSTMENT','STOCK_MOVE','STOCK_CHECK',
       'DEFECTIVE_RETURN','DEFECTIVE_REPAIR_RESTOCK','DEFECTIVE_PRODUCTION_RETURN','REVERSAL'))`);
    await q.query(`ALTER TABLE stock_document_receipt_allocations ADD COLUMN IF NOT EXISTS defect_reason varchar(500)`);

    // Every posted receipt gets an explicit allocation so production completion can use qualified quantity.
    await q.query(`INSERT INTO stock_document_receipt_allocations(document_line_id,disposition,warehouse_id,location_id,batch_id,quantity)
      SELECT l.id,'NORMAL',d.warehouse_id,l.location_id,l.batch_id,l.quantity
      FROM stock_document_lines l JOIN stock_documents d ON d.id=l.document_id
      WHERE d.document_type IN ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_RETURN','PRODUCTION_COMPLETION')
        AND d.status='POSTED'
        AND NOT EXISTS(SELECT 1 FROM stock_document_receipt_allocations a WHERE a.document_line_id=l.id)
      ON CONFLICT DO NOTHING`);

    // Round stored business quantities. Positive source quantities remain at least one.
    await q.query(`UPDATE items SET minimum_stock=round(minimum_stock)`);
    await q.query(`UPDATE bom_items SET qty_per=greatest(1,round(qty_per))`);
    await q.query(`UPDATE production_orders SET planned_qty=greatest(1,round(planned_qty)),completed_qty=round(completed_qty)`);
    await q.query(`UPDATE production_order_materials SET
      qty_per=greatest(1,round(qty_per)),required_qty=greatest(1,round(required_qty)),
      issued_qty=round(issued_qty),returned_qty=round(returned_qty),
      spare_issued_qty=round(spare_issued_qty),spare_returned_qty=round(spare_returned_qty)`);
    await q.query(`UPDATE stock_document_lines SET
      quantity=greatest(1,round(quantity)),normal_qty=round(normal_qty),spare_qty=round(spare_qty)`);
    await q.query(`UPDATE stock_document_receipt_allocations SET quantity=greatest(1,round(quantity))`);
    await q.query(`UPDATE stock_document_lines l SET quantity=a.quantity
      FROM (SELECT document_line_id,sum(quantity) quantity FROM stock_document_receipt_allocations GROUP BY document_line_id) a
      WHERE a.document_line_id=l.id`);
    await q.query(`UPDATE stock_reservations r SET quantity=l.quantity FROM stock_document_lines l WHERE l.id=r.document_line_id`);
    await q.query(`UPDATE production_issue_materials SET
      required_qty=greatest(1,round(required_qty)),pending_qty=round(pending_qty),
      normal_requested_qty=round(normal_requested_qty),spare_requested_qty=round(spare_requested_qty),
      normal_allocated_qty=round(normal_allocated_qty),spare_allocated_qty=round(spare_allocated_qty),
      shortage_qty=round(shortage_qty)`);
    await q.query(`UPDATE warehouse_locations SET capacity=round(capacity) WHERE capacity IS NOT NULL`);

    await q.query(`ALTER TABLE stock_transactions DISABLE TRIGGER trg_stock_transactions_immutable`);
    await q.query(`UPDATE stock_transactions SET delta_qty=sign(delta_qty)*greatest(1,round(abs(delta_qty)))`);
    await q.query(`WITH running AS (
        SELECT id,sum(delta_qty) OVER (
          PARTITION BY warehouse_id,location_id,item_id,batch_id
          ORDER BY created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) balance_after
        FROM stock_transactions
      )
      UPDATE stock_transactions t SET balance_after=r.balance_after,balance_before=r.balance_after-t.delta_qty
      FROM running r WHERE r.id=t.id`);
    await q.query(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM stock_transactions WHERE balance_before<0 OR balance_after<0) THEN
        RAISE EXCEPTION '整数转换后出现负库存，请检查迁移异常清单';
      END IF;
    END $$`);
    await q.query(`ALTER TABLE stock_transactions ENABLE TRIGGER trg_stock_transactions_immutable`);
    await q.query(`UPDATE stock_balances sb SET on_hand_qty=COALESCE((
        SELECT t.balance_after FROM stock_transactions t
        WHERE t.warehouse_id=sb.warehouse_id AND t.location_id=sb.location_id AND t.item_id=sb.item_id
          AND t.batch_id IS NOT DISTINCT FROM sb.batch_id
        ORDER BY t.created_at DESC,t.id DESC LIMIT 1
      ),round(sb.on_hand_qty)),frozen_qty=round(sb.frozen_qty)`);

    const quantityColumns: Array<[string, string]> = [
      ['items','minimum_stock'],['bom_items','qty_per'],['production_orders','planned_qty'],
      ['production_orders','completed_qty'],['production_order_materials','qty_per'],
      ['production_order_materials','required_qty'],['production_order_materials','issued_qty'],
      ['production_order_materials','returned_qty'],['production_order_materials','spare_issued_qty'],
      ['production_order_materials','spare_returned_qty'],['stock_document_lines','quantity'],
      ['stock_document_lines','normal_qty'],['stock_document_lines','spare_qty'],
      ['stock_balances','on_hand_qty'],['stock_balances','frozen_qty'],
      ['stock_transactions','balance_before'],['stock_transactions','delta_qty'],
      ['stock_transactions','balance_after'],['stock_document_receipt_allocations','quantity'],
      ['stock_reservations','quantity'],['production_issue_materials','required_qty'],
      ['production_issue_materials','pending_qty'],['production_issue_materials','normal_requested_qty'],
      ['production_issue_materials','spare_requested_qty'],['production_issue_materials','normal_allocated_qty'],
      ['production_issue_materials','spare_allocated_qty'],['production_issue_materials','shortage_qty'],
      ['warehouse_locations','capacity'],
    ];
    for (const [table, column] of quantityColumns) {
      await q.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE numeric(18,0) USING round(${column})`);
    }
    await q.query(`DO $$ BEGIN
      IF EXISTS(
        SELECT 1
        FROM stock_document_lines l
        JOIN stock_documents d ON d.id=l.document_id
        LEFT JOIN (
          SELECT document_line_id,sum(quantity) quantity
          FROM stock_document_receipt_allocations
          GROUP BY document_line_id
        ) a ON a.document_line_id=l.id
        WHERE d.status='POSTED'
          AND d.document_type IN ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_RETURN','PRODUCTION_COMPLETION')
          AND COALESCE(a.quantity,0)<>l.quantity
      ) THEN
        RAISE EXCEPTION 'Integer migration produced a receipt allocation mismatch; migration aborted';
      END IF;
      IF EXISTS(SELECT 1 FROM production_orders WHERE completed_qty>planned_qty) THEN
        RAISE EXCEPTION 'Integer migration produced production completion above plan; migration aborted';
      END IF;
      IF EXISTS(
        SELECT 1
        FROM stock_balances sb
        LEFT JOIN LATERAL (
          SELECT balance_after
          FROM stock_transactions t
          WHERE t.warehouse_id=sb.warehouse_id
            AND t.location_id=sb.location_id
            AND t.item_id=sb.item_id
            AND t.batch_id IS NOT DISTINCT FROM sb.batch_id
          ORDER BY t.created_at DESC,t.id DESC
          LIMIT 1
        ) ledger ON true
        WHERE sb.on_hand_qty<>COALESCE(ledger.balance_after,0)
      ) THEN
        RAISE EXCEPTION 'Integer migration inventory reconciliation failed; migration aborted';
      END IF;
    END $$`);

    await q.query(`CREATE TABLE defective_inventory_lots(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_allocation_id uuid REFERENCES stock_document_receipt_allocations(id) ON DELETE RESTRICT,
      source_document_id uuid REFERENCES stock_documents(id) ON DELETE RESTRICT,
      source_document_line_id uuid REFERENCES stock_document_lines(id) ON DELETE RESTRICT,
      item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
      warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      location_id uuid NOT NULL REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
      batch_id uuid REFERENCES inventory_batches(id) ON DELETE RESTRICT,
      production_order_id uuid REFERENCES production_orders(id) ON DELETE RESTRICT,
      defect_reason varchar(500) NOT NULL,
      received_qty numeric(18,0) NOT NULL CHECK(received_qty>0),
      remaining_qty numeric(18,0) NOT NULL CHECK(remaining_qty>=0 AND remaining_qty<=received_qty),
      status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX ix_defective_lots_open ON defective_inventory_lots(status,item_id,created_at)`);
    await q.query(`INSERT INTO defective_inventory_lots(item_id,warehouse_id,location_id,batch_id,defect_reason,received_qty,remaining_qty,created_at)
      SELECT sb.item_id,sb.warehouse_id,sb.location_id,sb.batch_id,'历史库存导入',sb.on_hand_qty,sb.on_hand_qty,sb.updated_at
      FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id
      WHERE w.warehouse_type='DEFECTIVE' AND sb.on_hand_qty>0`);

    await q.query(`CREATE TABLE defective_disposition_records(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_id uuid NOT NULL REFERENCES defective_inventory_lots(id) ON DELETE RESTRICT,
      document_id uuid NOT NULL REFERENCES stock_documents(id) ON DELETE RESTRICT,
      action varchar(40) NOT NULL CHECK(action IN ('RETURN','REPAIR_RESTOCK','RETURN_PRODUCTION')),
      quantity numeric(18,0) NOT NULL CHECK(quantity>0),
      reason varchar(500) NOT NULL,
      target_warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
      target_location_id uuid REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
      production_order_id uuid REFERENCES production_orders(id) ON DELETE RESTRICT,
      processed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      processed_by_username varchar(100),processed_by_name varchar(150),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX ix_defective_dispositions_lot_time ON defective_disposition_records(lot_id,created_at DESC)`);
    await q.query(`CREATE OR REPLACE FUNCTION prevent_defective_disposition_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'defective disposition records are immutable'; END; $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER defective_disposition_immutable BEFORE UPDATE OR DELETE ON defective_disposition_records
      FOR EACH ROW EXECUTE FUNCTION prevent_defective_disposition_mutation()`);

    await q.query(`INSERT INTO permissions(code,name) VALUES
      ('approval.defective.view','查看不良品处理'),
      ('approval.defective.process','处理不良品')
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name`);
    await q.query(`INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
      WHERE r.code IN ('ADMIN','WAREHOUSE') AND p.code IN ('approval.defective.view','approval.defective.process')
      ON CONFLICT DO NOTHING`);
    await q.query(`DELETE FROM role_permissions rp USING permissions p
      WHERE p.id=rp.permission_id AND p.code IN ('stock.approve','stock.reject','stock.direct_post')`);
  }

  async down(): Promise<void> {
    throw new Error('整数数量和不良品追溯迁移为前向迁移；回滚请恢复升级前备份。');
  }
}
