import { MigrationInterface, QueryRunner } from 'typeorm';

export class WarehouseLocationManagement1810000000000 implements MigrationInterface {
  name = 'WarehouseLocationManagement1810000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE warehouse_zones ADD COLUMN IF NOT EXISTS location_count integer NOT NULL DEFAULT 1;
      ALTER TABLE warehouse_zones ADD CONSTRAINT warehouse_zones_location_count_check CHECK(location_count BETWEEN 1 AND 500);

      ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS sort_order integer;
      ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;
      ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;

      UPDATE warehouse_locations SET sort_order=0 WHERE system_default=true AND sort_order IS NULL;
      WITH numbered AS (
        SELECT id,row_number() OVER (PARTITION BY zone_id ORDER BY created_at,id)::int rn
        FROM warehouse_locations WHERE system_default=false AND sort_order IS NULL
      ) UPDATE warehouse_locations l SET sort_order=n.rn FROM numbered n WHERE n.id=l.id;

      DO $$
      DECLARE duplicated text;
      BEGIN
        SELECT string_agg(code, '、' ORDER BY code) INTO duplicated
        FROM (SELECT code FROM warehouse_locations GROUP BY code HAVING count(*)>1 LIMIT 10) d;
        IF duplicated IS NOT NULL THEN
          RAISE EXCEPTION '无法升级：存在重复库位编码 %，请先处理后重试', duplicated;
        END IF;
      END $$;

      CREATE UNIQUE INDEX IF NOT EXISTS ux_warehouse_locations_code_global ON warehouse_locations(code);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_warehouse_locations_zone_sort_active
        ON warehouse_locations(zone_id,sort_order) WHERE is_archived=false AND sort_order IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ix_warehouse_locations_zone_auto
        ON warehouse_locations(zone_id,auto_generated,is_archived,sort_order);
    `);
  }

  async down(): Promise<void> {
    throw new Error('库位数量管理迁移包含安全归档语义，禁止自动回滚；请恢复升级前数据库备份。');
  }
}
