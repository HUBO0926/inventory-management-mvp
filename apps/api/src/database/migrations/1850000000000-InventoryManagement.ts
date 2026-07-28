import { MigrationInterface, QueryRunner } from 'typeorm';

export class InventoryManagement1850000000000 implements MigrationInterface {
  name = 'InventoryManagement1850000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      INSERT INTO permissions(code,name)
      VALUES('inventory.report.view','查看库存报表')
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name
    `);
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
      WHERE p.code='inventory.report.view'
        AND (
          r.code IN ('ADMIN','WAREHOUSE')
          OR (r.code NOT IN ('ADMIN','WAREHOUSE','PRODUCTION') AND EXISTS (
            SELECT 1 FROM role_permissions rp
            JOIN permissions current_permission ON current_permission.id=rp.permission_id
            WHERE rp.role_id=r.id AND current_permission.code='inventory.view'
          ))
        )
      ON CONFLICT DO NOTHING
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_documents_created_posted ON stock_documents(created_at DESC,posted_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_documents_created_by ON stock_documents(created_by,created_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_transactions_document_time ON stock_transactions(source_document_id,created_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS ix_stock_transactions_document_time`);
    await q.query(`DROP INDEX IF EXISTS ix_stock_documents_created_by`);
    await q.query(`DROP INDEX IF EXISTS ix_stock_documents_created_posted`);
    await q.query(`DELETE FROM permissions WHERE code='inventory.report.view'`);
  }
}
