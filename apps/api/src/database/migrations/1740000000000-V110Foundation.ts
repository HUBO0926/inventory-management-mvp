import { MigrationInterface, QueryRunner } from 'typeorm';

export class V110Foundation1740000000000 implements MigrationInterface {
  name = 'V110Foundation1740000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE item_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(50) NOT NULL UNIQUE,
        name varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE units (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(50) NOT NULL UNIQUE,
        name varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO item_categories(code,name) VALUES('UNCATEGORIZED','未分类');
      INSERT INTO units(code,name)
        SELECT DISTINCT upper(substr(md5(unit),1,12)), unit FROM items
        ON CONFLICT(code) DO NOTHING;

      ALTER TABLE items ADD COLUMN category_id uuid REFERENCES item_categories(id);
      ALTER TABLE items ADD COLUMN unit_id uuid REFERENCES units(id);
      UPDATE items SET category_id=(SELECT id FROM item_categories WHERE code='UNCATEGORIZED');
      UPDATE items i SET unit_id=u.id FROM units u WHERE u.name=i.unit;
      ALTER TABLE items ALTER COLUMN category_id SET NOT NULL;
      ALTER TABLE items ALTER COLUMN unit_id SET NOT NULL;

      CREATE TABLE roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(50) NOT NULL UNIQUE,
        name varchar(100) NOT NULL,
        system_protected boolean NOT NULL DEFAULT false,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE permissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(100) NOT NULL UNIQUE,
        name varchar(120) NOT NULL
      );
      CREATE TABLE role_permissions (
        role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        PRIMARY KEY(role_id,permission_id)
      );
      INSERT INTO roles(code,name,system_protected) VALUES
        ('ADMIN','系统管理员',true),('WAREHOUSE','仓库管理员',true),('PRODUCTION','生产人员',true);
      INSERT INTO permissions(code,name) VALUES
        ('master.view','查看基础数据'),('master.manage','维护基础数据'),('master.delete','删除基础数据'),
        ('bom.view','查看BOM'),('bom.manage','维护BOM'),('bom.delete','删除BOM'),
        ('stock.view','查看库存业务'),('stock.create','创建库存单据'),('stock.edit','编辑库存单据'),
        ('stock.submit','提交库存单据'),('stock.approve','审核库存单据'),('stock.reject','驳回库存单据'),
        ('stock.withdraw','撤回库存单据'),('stock.void','冲销库存单据'),('stock.direct_post','兼容直接过账'),
        ('inventory.view','查看库存'),('inventory.export','导出库存'),('inventory.reconcile','库存对账'),
        ('production.view','查看生产任务'),('production.manage','维护生产任务'),
        ('production.issue','生产领退料'),('production.complete','完工报产'),
        ('user.manage','管理账号'),('role.manage','管理角色权限'),('audit.view','查看操作日志'),
        ('system.version.view','查看系统版本');
      INSERT INTO role_permissions(role_id,permission_id)
        SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='ADMIN';
      INSERT INTO role_permissions(role_id,permission_id)
        SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN
        ('master.view','bom.view','stock.view','stock.create','stock.edit','stock.submit','stock.approve',
         'stock.reject','stock.withdraw','stock.void','inventory.view','inventory.export',
         'production.view','production.issue','system.version.view')
        WHERE r.code='WAREHOUSE';
      INSERT INTO role_permissions(role_id,permission_id)
        SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN
        ('master.view','bom.view','stock.view','inventory.view','production.view','production.manage',
         'production.complete','system.version.view')
        WHERE r.code='PRODUCTION';
      ALTER TABLE users ADD COLUMN role_id uuid REFERENCES roles(id);
      UPDATE users u SET role_id=r.id FROM roles r WHERE r.code=u.role;
      ALTER TABLE users ALTER COLUMN role_id SET NOT NULL;

      CREATE TABLE warehouse_zones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id),
        code varchar(50) NOT NULL,
        name varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(warehouse_id,code)
      );
      CREATE TABLE warehouse_locations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id),
        zone_id uuid NOT NULL REFERENCES warehouse_zones(id),
        code varchar(50) NOT NULL,
        name varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(warehouse_id,code)
      );
      INSERT INTO warehouse_zones(warehouse_id,code,name)
        SELECT id,'DEFAULT','默认库区' FROM warehouses;
      INSERT INTO warehouse_locations(warehouse_id,zone_id,code,name)
        SELECT w.id,z.id,w.warehouse_code||'-DEFAULT','默认库位'
        FROM warehouses w JOIN warehouse_zones z ON z.warehouse_id=w.id AND z.code='DEFAULT';

      CREATE TABLE inventory_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id uuid NOT NULL REFERENCES items(id),
        batch_no varchar(80) NOT NULL,
        notes varchar(300),
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(item_id,batch_no)
      );
      ALTER TABLE stock_document_lines ADD COLUMN location_id uuid REFERENCES warehouse_locations(id);
      ALTER TABLE stock_document_lines ADD COLUMN batch_id uuid REFERENCES inventory_batches(id);
      UPDATE stock_document_lines l SET location_id=loc.id
        FROM stock_documents d
        JOIN warehouse_locations loc ON loc.warehouse_id=d.warehouse_id AND loc.code LIKE '%-DEFAULT'
        WHERE d.id=l.document_id;
      ALTER TABLE stock_document_lines ALTER COLUMN location_id SET NOT NULL;

      ALTER TABLE stock_balances ADD COLUMN location_id uuid REFERENCES warehouse_locations(id);
      ALTER TABLE stock_balances ADD COLUMN batch_id uuid REFERENCES inventory_batches(id);
      UPDATE stock_balances b SET location_id=loc.id
        FROM warehouse_locations loc
        WHERE loc.warehouse_id=b.warehouse_id AND loc.code LIKE '%-DEFAULT';
      ALTER TABLE stock_balances ALTER COLUMN location_id SET NOT NULL;
      ALTER TABLE stock_balances DROP CONSTRAINT IF EXISTS stock_balances_warehouse_id_item_id_key;
      CREATE UNIQUE INDEX ux_stock_balance_dimension
        ON stock_balances(warehouse_id,location_id,item_id,batch_id) NULLS NOT DISTINCT;

      DROP TRIGGER IF EXISTS trg_stock_transactions_immutable ON stock_transactions;
      ALTER TABLE stock_transactions ADD COLUMN location_id uuid REFERENCES warehouse_locations(id);
      ALTER TABLE stock_transactions ADD COLUMN batch_id uuid REFERENCES inventory_batches(id);
      ALTER TABLE stock_transactions ADD COLUMN balance_before numeric(18,4);
      UPDATE stock_transactions t SET
        location_id=loc.id,
        balance_before=t.balance_after-t.delta_qty
        FROM warehouse_locations loc
        WHERE loc.warehouse_id=t.warehouse_id AND loc.code LIKE '%-DEFAULT';
      ALTER TABLE stock_transactions ALTER COLUMN location_id SET NOT NULL;
      ALTER TABLE stock_transactions ALTER COLUMN balance_before SET NOT NULL;
      CREATE TRIGGER trg_stock_transactions_immutable BEFORE UPDATE OR DELETE ON stock_transactions
        FOR EACH ROW EXECUTE FUNCTION prevent_stock_transaction_mutation();

      ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_status_check;
      ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_status_check
        CHECK(status IN ('DRAFT','SUBMITTED','REJECTED','POSTED','VOIDED'));
      ALTER TABLE stock_documents ADD COLUMN submitted_by uuid REFERENCES users(id);
      ALTER TABLE stock_documents ADD COLUMN submitted_at timestamptz;
      ALTER TABLE stock_documents ADD COLUMN approved_by uuid REFERENCES users(id);
      ALTER TABLE stock_documents ADD COLUMN approved_at timestamptz;
      ALTER TABLE stock_documents ADD COLUMN rejected_by uuid REFERENCES users(id);
      ALTER TABLE stock_documents ADD COLUMN rejected_at timestamptz;
      ALTER TABLE stock_documents ADD COLUMN rejection_reason varchar(500);
      ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_document_type_check;
      ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_document_type_check CHECK(document_type IN
        ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION',
         'FINISHED_OUTBOUND','INVENTORY_ADJUSTMENT','REVERSAL'));

      ALTER TABLE operation_logs ADD COLUMN request_id varchar(100);
      ALTER TABLE operation_logs ADD COLUMN ip varchar(80);
      ALTER TABLE operation_logs ADD COLUMN result varchar(20) NOT NULL DEFAULT 'SUCCESS';
      ALTER TABLE operation_logs ADD COLUMN error_code varchar(80);
      ALTER TABLE operation_logs ADD COLUMN app_version varchar(30);

      CREATE INDEX ix_stock_balances_dimension ON stock_balances(warehouse_id,location_id,item_id,batch_id);
      CREATE INDEX ix_stock_transactions_dimension ON stock_transactions(warehouse_id,location_id,item_id,batch_id,created_at DESC);
      CREATE INDEX ix_documents_approval ON stock_documents(status,submitted_at DESC);
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP INDEX IF EXISTS ix_documents_approval;
      DROP INDEX IF EXISTS ix_stock_transactions_dimension;
      DROP INDEX IF EXISTS ix_stock_balances_dimension;
      ALTER TABLE operation_logs DROP COLUMN IF EXISTS app_version,DROP COLUMN IF EXISTS error_code,
        DROP COLUMN IF EXISTS result,DROP COLUMN IF EXISTS ip,DROP COLUMN IF EXISTS request_id;
      ALTER TABLE stock_documents DROP COLUMN IF EXISTS rejection_reason,DROP COLUMN IF EXISTS rejected_at,
        DROP COLUMN IF EXISTS rejected_by,DROP COLUMN IF EXISTS approved_at,DROP COLUMN IF EXISTS approved_by,
        DROP COLUMN IF EXISTS submitted_at,DROP COLUMN IF EXISTS submitted_by;
      ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_status_check;
      ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_status_check CHECK(status IN ('DRAFT','POSTED','VOIDED'));
      ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_document_type_check;
      ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_document_type_check CHECK(document_type IN
        ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION','FINISHED_OUTBOUND','REVERSAL'));
      DROP INDEX IF EXISTS ux_stock_balance_dimension;
      ALTER TABLE stock_transactions DROP COLUMN IF EXISTS balance_before,DROP COLUMN IF EXISTS batch_id,DROP COLUMN IF EXISTS location_id;
      ALTER TABLE stock_balances DROP COLUMN IF EXISTS batch_id,DROP COLUMN IF EXISTS location_id;
      ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_warehouse_id_item_id_key UNIQUE(warehouse_id,item_id);
      ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS batch_id,DROP COLUMN IF EXISTS location_id;
      DROP TABLE IF EXISTS inventory_batches,warehouse_locations,warehouse_zones CASCADE;
      ALTER TABLE users DROP COLUMN IF EXISTS role_id;
      DROP TABLE IF EXISTS role_permissions,permissions,roles CASCADE;
      ALTER TABLE items DROP COLUMN IF EXISTS unit_id,DROP COLUMN IF EXISTS category_id;
      DROP TABLE IF EXISTS units,item_categories CASCADE;
    `);
  }
}
