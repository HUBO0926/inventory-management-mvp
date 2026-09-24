import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinishedInboundLocationSelectionIndexes1960000000000 implements MigrationInterface {
  name = 'FinishedInboundLocationSelectionIndexes1960000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_balances_item_warehouse_location ON stock_balances(item_id,warehouse_id,location_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_reservations_active_item_location ON stock_reservations(item_id,warehouse_id,location_id) WHERE status='ACTIVE'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS ix_stock_reservations_active_item_location`);
    await q.query(`DROP INDEX IF EXISTS ix_stock_balances_item_warehouse_location`);
  }
}
