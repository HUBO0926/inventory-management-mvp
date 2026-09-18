import { MigrationInterface, QueryRunner } from 'typeorm';

export class WarehouseManagementWorkbench1940000000000 implements MigrationInterface {
  name = 'WarehouseManagementWorkbench1940000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS stock_check_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        location_id uuid NOT NULL REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
        item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
        batch_id uuid REFERENCES inventory_batches(id) ON DELETE RESTRICT,
        counted_qty numeric(18,0) NOT NULL CHECK(counted_qty >= 0),
        system_qty_snapshot numeric(18,0),
        difference_qty numeric(18,0),
        notes varchar(300),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_check_lines_dimension
        ON stock_check_lines(document_id,location_id,item_id,COALESCE(batch_id,'00000000-0000-0000-0000-000000000000'::uuid));
      CREATE INDEX IF NOT EXISTS ix_stock_check_lines_document ON stock_check_lines(document_id,location_id,item_id);

      CREATE TABLE IF NOT EXISTS location_item_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL REFERENCES warehouse_locations(id) ON DELETE CASCADE,
        item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        allowed boolean NOT NULL DEFAULT true,
        notes varchar(300),
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_by_username varchar(50),
        created_by_name varchar(100),
        updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
        updated_by_username varchar(50),
        updated_by_name varchar(100),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(location_id,item_id)
      );
      CREATE INDEX IF NOT EXISTS ix_location_item_rules_item ON location_item_rules(item_id,location_id);

      CREATE TABLE IF NOT EXISTS warehouse_operation_locks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scope_type varchar(20) NOT NULL CHECK(scope_type IN ('WAREHOUSE','ZONE','LOCATION')),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        zone_id uuid REFERENCES warehouse_zones(id) ON DELETE CASCADE,
        location_id uuid REFERENCES warehouse_locations(id) ON DELETE CASCADE,
        reason varchar(500) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RELEASED')),
        locked_by uuid REFERENCES users(id) ON DELETE SET NULL,
        locked_by_username varchar(50),
        locked_by_name varchar(100),
        locked_by_department varchar(100),
        released_by uuid REFERENCES users(id) ON DELETE SET NULL,
        released_by_username varchar(50),
        released_by_name varchar(100),
        released_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(
          (scope_type='WAREHOUSE' AND zone_id IS NULL AND location_id IS NULL) OR
          (scope_type='ZONE' AND zone_id IS NOT NULL AND location_id IS NULL) OR
          (scope_type='LOCATION' AND zone_id IS NOT NULL AND location_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_warehouse_operation_locks_active
        ON warehouse_operation_locks(scope_type,warehouse_id,COALESCE(zone_id,'00000000-0000-0000-0000-000000000000'::uuid),COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid))
        WHERE status='ACTIVE';
      CREATE INDEX IF NOT EXISTS ix_warehouse_operation_locks_effective
        ON warehouse_operation_locks(warehouse_id,zone_id,location_id,status);

      CREATE TABLE IF NOT EXISTS inventory_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        alert_key varchar(300) NOT NULL,
        alert_type varchar(30) NOT NULL CHECK(alert_type IN ('LOW_STOCK','CAPACITY_WARNING','CAPACITY_FULL','OPERATION_LOCKED')),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        zone_id uuid REFERENCES warehouse_zones(id) ON DELETE CASCADE,
        location_id uuid REFERENCES warehouse_locations(id) ON DELETE CASCADE,
        item_id uuid REFERENCES items(id) ON DELETE CASCADE,
        status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
        message varchar(500) NOT NULL,
        opened_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_inventory_alerts_open ON inventory_alerts(alert_key) WHERE status='OPEN';
      CREATE INDEX IF NOT EXISTS ix_inventory_alerts_scope ON inventory_alerts(warehouse_id,status,alert_type,updated_at DESC);

      INSERT INTO permissions(code,name) VALUES
        ('stock.count','库存盘点'),('stock.freeze','仓储空间作业锁定')
        ON CONFLICT(code) DO NOTHING;
      INSERT INTO role_permissions(role_id,permission_id)
        SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN ('stock.count','stock.freeze')
        WHERE r.code='ADMIN' ON CONFLICT(role_id,permission_id) DO NOTHING;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE IF EXISTS inventory_alerts;
      DROP TABLE IF EXISTS warehouse_operation_locks;
      DROP TABLE IF EXISTS location_item_rules;
      DROP TABLE IF EXISTS stock_check_lines;
    `);
  }
}
