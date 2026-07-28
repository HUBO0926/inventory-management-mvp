import { MigrationInterface, QueryRunner } from 'typeorm';

export class DefectiveWarehouseAndMove1790000000000 implements MigrationInterface {
  name = 'DefectiveWarehouseAndMove1790000000000';

  async up(q: QueryRunner): Promise<void> {
    const [{ count: openSemiOrders }] = await q.query(`
      SELECT count(*)::int count
      FROM production_orders o JOIN items i ON i.id=o.finished_good_id
      WHERE i.item_type='SEMI_FINISHED' AND o.status NOT IN ('COMPLETED','CANCELLED','CLOSED')
    `);
    if (Number(openSemiOrders) > 0) {
      throw new Error(`无法下线半成品：仍有 ${openSemiOrders} 张未结束的半成品生产任务，请先完成或取消任务。`);
    }

    await q.query(`ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_warehouse_type_check`);
    await q.query(`ALTER TABLE warehouses ADD CONSTRAINT warehouses_warehouse_type_check CHECK(warehouse_type IN ('RAW','FG','DEFECTIVE'))`);
    await q.query(`ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_document_type_check`);
    await q.query(`ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_document_type_check CHECK(document_type IN
      ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION','FINISHED_OUTBOUND','INVENTORY_ADJUSTMENT','STOCK_MOVE','REVERSAL'))`);

    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS target_warehouse_id uuid REFERENCES warehouses(id)`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS target_location_id uuid REFERENCES warehouse_locations(id)`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS target_batch_id uuid REFERENCES inventory_batches(id)`);
    await q.query(`CREATE TABLE IF NOT EXISTS stock_document_receipt_allocations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_line_id uuid NOT NULL REFERENCES stock_document_lines(id) ON DELETE CASCADE,
      disposition varchar(16) NOT NULL CHECK(disposition IN ('NORMAL','DEFECTIVE')),
      warehouse_id uuid NOT NULL REFERENCES warehouses(id),
      location_id uuid NOT NULL REFERENCES warehouse_locations(id),
      batch_id uuid REFERENCES inventory_batches(id),
      quantity numeric(18,4) NOT NULL CHECK(quantity>0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(document_line_id,disposition,warehouse_id,location_id,batch_id)
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_receipt_allocations_line ON stock_document_receipt_allocations(document_line_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_document_lines_target_location ON stock_document_lines(target_location_id)`);

    await q.query(`UPDATE boms b SET status='INACTIVE',updated_at=now()
      WHERE b.deleted_at IS NULL AND EXISTS(
        SELECT 1 FROM items o WHERE o.id=b.finished_good_id AND o.item_type='SEMI_FINISHED'
      ) OR EXISTS(
        SELECT 1 FROM bom_items bi JOIN items m ON m.id=bi.material_id
        WHERE bi.bom_id=b.id AND m.item_type='SEMI_FINISHED'
      )`);
    await q.query(`UPDATE items SET status='INACTIVE',deleted_at=COALESCE(deleted_at,now()),updated_at=now()
      WHERE item_type='SEMI_FINISHED'`);
    await q.query(`UPDATE item_categories SET status='INACTIVE',updated_at=now() WHERE item_type='SEMI_FINISHED'`);
  }

  async down(): Promise<void> {
    throw new Error('该迁移包含半成品归档及库存单据扩展，请通过升级前备份回滚。');
  }
}
