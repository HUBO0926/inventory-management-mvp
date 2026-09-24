import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinishedInboundPerformanceIndexes1970000000000 implements MigrationInterface {
  name = 'FinishedInboundPerformanceIndexes1970000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX IF NOT EXISTS ix_capacity_reservations_active_item_scope ON location_capacity_reservations(item_id,warehouse_id,location_id) INCLUDE (quantity) WHERE status='ACTIVE'`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_warehouse_locations_active_tree ON warehouse_locations(warehouse_id,zone_id) WHERE status='ACTIVE' AND is_archived=false`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS ix_warehouse_locations_active_tree`);
    await q.query(`DROP INDEX IF EXISTS ix_capacity_reservations_active_item_scope`);
  }
}
