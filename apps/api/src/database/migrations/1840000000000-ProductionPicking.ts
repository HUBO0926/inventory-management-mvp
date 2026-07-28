import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductionPicking1840000000000 implements MigrationInterface {
  name = 'ProductionPicking1840000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS default_issue_warehouse_id uuid REFERENCES warehouses(id)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS shortage_checked_at timestamptz`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS shortage_summary jsonb`);
    await q.query(`ALTER TABLE production_order_materials ADD COLUMN IF NOT EXISTS spare_issued_qty numeric(18,4) NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE production_order_materials ADD COLUMN IF NOT EXISTS spare_returned_qty numeric(18,4) NOT NULL DEFAULT 0`);

    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS issue_mode varchar(20)`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS source_warehouse_id uuid REFERENCES warehouses(id)`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS normal_qty numeric(18,4) NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS spare_qty numeric(18,4) NOT NULL DEFAULT 0`);
    await q.query(`UPDATE stock_document_lines l SET normal_qty=l.quantity
      FROM stock_documents d WHERE d.id=l.document_id AND d.document_type='PRODUCTION_ISSUE' AND l.normal_qty=0 AND l.spare_qty=0`);

    await q.query(`CREATE TABLE IF NOT EXISTS production_issue_materials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
      material_id uuid NOT NULL REFERENCES items(id),
      required_qty numeric(18,4) NOT NULL,
      pending_qty numeric(18,4) NOT NULL,
      normal_requested_qty numeric(18,4) NOT NULL DEFAULT 0,
      spare_requested_qty numeric(18,4) NOT NULL DEFAULT 0,
      normal_allocated_qty numeric(18,4) NOT NULL DEFAULT 0,
      spare_allocated_qty numeric(18,4) NOT NULL DEFAULT 0,
      shortage_qty numeric(18,4) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(document_id,material_id)
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_production_issue_materials_document ON production_issue_materials(document_id,material_id)`);

    await q.query(`CREATE TABLE IF NOT EXISTS stock_reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
      document_line_id uuid NOT NULL REFERENCES stock_document_lines(id) ON DELETE CASCADE,
      warehouse_id uuid NOT NULL REFERENCES warehouses(id),
      location_id uuid NOT NULL REFERENCES warehouse_locations(id),
      item_id uuid NOT NULL REFERENCES items(id),
      batch_id uuid REFERENCES inventory_batches(id),
      quantity numeric(18,4) NOT NULL CHECK(quantity>0),
      status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CONSUMED','RELEASED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      released_at timestamptz,
      UNIQUE(document_line_id)
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_reservations_dimension ON stock_reservations(warehouse_id,location_id,item_id,batch_id,status)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_reservations_document ON stock_reservations(document_id,status)`);

    await q.query(`ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_status_check`);
    await q.query(`ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_status_check CHECK(status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','POSTED','VOIDED','CANCELLED'))`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS stock_reservations`);
    await q.query(`DROP TABLE IF EXISTS production_issue_materials`);
    await q.query(`ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS spare_qty,DROP COLUMN IF EXISTS normal_qty,DROP COLUMN IF EXISTS source_warehouse_id`);
    await q.query(`ALTER TABLE stock_documents DROP COLUMN IF EXISTS issue_mode`);
    await q.query(`ALTER TABLE production_order_materials DROP COLUMN IF EXISTS spare_returned_qty,DROP COLUMN IF EXISTS spare_issued_qty`);
    await q.query(`ALTER TABLE production_orders DROP COLUMN IF EXISTS shortage_summary,DROP COLUMN IF EXISTS shortage_checked_at,DROP COLUMN IF EXISTS default_issue_warehouse_id`);
  }
}
