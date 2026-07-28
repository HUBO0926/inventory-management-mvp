import { MigrationInterface, QueryRunner } from 'typeorm';

export class MasterDataFlexibility1780000000000 implements MigrationInterface {
  name = 'MasterDataFlexibility1780000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE items ALTER COLUMN category_id DROP NOT NULL;
      UPDATE item_categories SET system_protected=false;

      ALTER TABLE boms DROP CONSTRAINT IF EXISTS boms_finished_good_id_version_key;
      DROP INDEX IF EXISTS ux_boms_one_active;
      CREATE UNIQUE INDEX ux_boms_output_version_active_record
        ON boms(finished_good_id,version) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX ux_boms_one_active
        ON boms(finished_good_id) WHERE status='ACTIVE' AND deleted_at IS NULL;

      ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      ALTER TABLE warehouse_zones ADD COLUMN IF NOT EXISTS sequence_no integer;
      ALTER TABLE warehouse_zones ADD COLUMN IF NOT EXISTS actual_location varchar(200);
      ALTER TABLE warehouse_zones ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS system_default boolean NOT NULL DEFAULT false;

      WITH numbered AS (
        SELECT id,row_number() OVER (PARTITION BY warehouse_id ORDER BY created_at,id)::integer sequence_no
        FROM warehouse_zones
      )
      UPDATE warehouse_zones z SET sequence_no=n.sequence_no
      FROM numbered n WHERE n.id=z.id AND z.sequence_no IS NULL;

      UPDATE warehouse_zones
      SET actual_location=COALESCE(NULLIF(actual_location,''),NULLIF(name,''),'未填写')
      WHERE actual_location IS NULL OR actual_location='';

      UPDATE warehouse_zones SET code='__MIG__'||replace(id::text,'-','');
      UPDATE warehouse_zones z
      SET code=w.warehouse_code||lpad(z.sequence_no::text,2,'0')
      FROM warehouses w WHERE w.id=z.warehouse_id;

      WITH defaults AS (
        SELECT id,row_number() OVER (PARTITION BY zone_id ORDER BY created_at,id) rn
        FROM warehouse_locations
      )
      UPDATE warehouse_locations l SET system_default=(d.rn=1)
      FROM defaults d WHERE d.id=l.id;

      INSERT INTO warehouse_locations(
        id,warehouse_id,zone_id,code,name,status,system_default
      )
      SELECT gen_random_uuid(),z.warehouse_id,z.id,z.code||'-DEFAULT','内部默认库位','ACTIVE',true
      FROM warehouse_zones z
      WHERE NOT EXISTS(SELECT 1 FROM warehouse_locations l WHERE l.zone_id=z.id);

      UPDATE warehouse_locations SET code='__MIG__'||replace(id::text,'-','')
      WHERE system_default=true;
      UPDATE warehouse_locations l SET code=z.code||'-DEFAULT',name='内部默认库位'
      FROM warehouse_zones z WHERE z.id=l.zone_id AND l.system_default=true;

      ALTER TABLE warehouse_zones ALTER COLUMN sequence_no SET NOT NULL;
      ALTER TABLE warehouse_zones ALTER COLUMN actual_location SET NOT NULL;
      ALTER TABLE warehouse_zones
        ADD CONSTRAINT warehouse_zones_sequence_no_check CHECK(sequence_no BETWEEN 1 AND 99);
      ALTER TABLE warehouse_zones
        ADD CONSTRAINT warehouse_zones_warehouse_sequence_key UNIQUE(warehouse_id,sequence_no);

      CREATE TABLE IF NOT EXISTS system_seed_state(
        key varchar(80) PRIMARY KEY,
        completed_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  async down(): Promise<void> {
    throw new Error('该迁移包含安全归档和库区编号转换，禁止自动回滚；请恢复升级前数据库备份。');
  }
}
