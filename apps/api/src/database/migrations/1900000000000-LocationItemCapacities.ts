import { MigrationInterface, QueryRunner } from 'typeorm';

export class LocationItemCapacities1900000000000 implements MigrationInterface {
  name = 'LocationItemCapacities1900000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE location_item_capacities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL REFERENCES warehouse_locations(id) ON DELETE CASCADE,
        item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        capacity numeric(18,0) NOT NULL CHECK(capacity > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(location_id,item_id)
      )
    `);
    await q.query(`CREATE INDEX ix_location_item_capacities_item ON location_item_capacities(item_id,location_id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS location_item_capacities`);
  }
}
