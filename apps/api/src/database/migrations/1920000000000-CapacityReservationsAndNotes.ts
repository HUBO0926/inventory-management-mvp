import { MigrationInterface, QueryRunner } from 'typeorm';

export class CapacityReservationsAndNotes1920000000000 implements MigrationInterface {
  name = 'CapacityReservationsAndNotes1920000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE location_item_capacities ADD COLUMN IF NOT EXISTS notes varchar(500)`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS location_capacity_reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
        document_line_id uuid NOT NULL REFERENCES stock_document_lines(id) ON DELETE CASCADE,
        receipt_allocation_id uuid REFERENCES stock_document_receipt_allocations(id) ON DELETE CASCADE,
        warehouse_id uuid NOT NULL REFERENCES warehouses(id),
        location_id uuid NOT NULL REFERENCES warehouse_locations(id),
        item_id uuid NOT NULL REFERENCES items(id),
        quantity numeric(18,4) NOT NULL CHECK(quantity > 0),
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CONSUMED','RELEASED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        released_at timestamptz
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_location_capacity_reservations_dimension ON location_capacity_reservations(location_id,item_id,status)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_location_capacity_reservations_document ON location_capacity_reservations(document_id,status)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS location_capacity_reservations`);
    await q.query(`ALTER TABLE location_item_capacities DROP COLUMN IF EXISTS notes`);
  }
}
