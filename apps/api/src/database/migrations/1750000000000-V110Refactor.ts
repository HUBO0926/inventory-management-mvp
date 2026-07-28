import { MigrationInterface, QueryRunner } from 'typeorm';

export class V110Refactor1750000000000 implements MigrationInterface {
  name = 'V110Refactor1750000000000';

  async up(q: QueryRunner): Promise<void> {
    // ===  Phase 2: Account & Personnel Identity ===

    // users new columns
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_name varchar(100)`);
    await q.query(`UPDATE users SET employee_name = COALESCE(name, username) WHERE employee_name IS NULL`);
    await q.query(`ALTER TABLE users ALTER COLUMN employee_name SET NOT NULL`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_no varchar(50)`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department varchar(100)`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position varchar(100)`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(30)`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email varchar(100)`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS remarks varchar(500)`);

    // ===  Phase 2: Snapshot columns on business tables ===

    // items (物料) snapshot columns
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by_username varchar(50)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by_name varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by_department varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by_username varchar(50)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by_name varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by_department varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS enabled_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS enabled_by_username varchar(50)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS enabled_by_name varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS disabled_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS disabled_by_username varchar(50)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS disabled_by_name varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);

    // boms snapshot columns
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS created_by_username varchar(50)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS created_by_name varchar(100)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS updated_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS updated_by_username varchar(50)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS updated_by_name varchar(100)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS enabled_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS enabled_by_username varchar(50)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS enabled_by_name varchar(100)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS disabled_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS disabled_by_username varchar(50)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS disabled_by_name varchar(100)`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);

    // stock_documents snapshot columns for personnel chain
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS created_by_username varchar(50)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS created_by_name varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS created_by_department varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS submitted_by_username varchar(50)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS submitted_by_name varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS approved_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS approved_by_username varchar(50)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS approved_by_name varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS rejected_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS rejected_by_username varchar(50)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS rejected_by_name varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS voided_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS voided_by_username varchar(50)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS voided_by_name varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS posted_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS posted_by_username varchar(50)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS posted_by_name varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS withdrawn_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS withdrawn_by_username varchar(50)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS withdrawn_by_name varchar(100)`);
    await q.query(`ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);

    // Backfill existing stock_documents.created_by_* from users
    await q.query(`
      UPDATE stock_documents d SET
        created_by_user_id = d.created_by,
        created_by_username = u.username,
        created_by_name = u.employee_name,
        created_by_department = u.department
      FROM users u WHERE u.id = d.created_by AND d.created_by_user_id IS NULL
    `);

    // stock_transactions operator snapshots
    await q.query(`ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS operator_username varchar(50)`);
    await q.query(`ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS operator_name varchar(100)`);
    await q.query(`ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS operator_department varchar(100)`);
    await q.query(`ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS request_id varchar(50)`);

    // Backfill stock_transactions operator snapshots
    await q.query(`DROP TRIGGER IF EXISTS trg_stock_transactions_immutable ON stock_transactions`);
    await q.query(`
      UPDATE stock_transactions t SET
        operator_username = u.username,
        operator_name = u.employee_name,
        operator_department = u.department
      FROM users u WHERE u.id = t.created_by AND t.operator_username IS NULL
    `);
    await q.query(`UPDATE stock_transactions SET operator_name = '历史未知人员' WHERE operator_name IS NULL`);
    await q.query(`CREATE TRIGGER trg_stock_transactions_immutable BEFORE UPDATE OR DELETE ON stock_transactions
      FOR EACH ROW EXECUTE FUNCTION prevent_stock_transaction_mutation()`);

    // ===  Phase 3: Material Archive ===

    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS brand varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS model varchar(100)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS spec varchar(200)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS default_warehouse_id uuid REFERENCES warehouses(id)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS default_zone_id uuid REFERENCES warehouse_zones(id)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS enable_batch boolean NOT NULL DEFAULT false`);

    // Relax item_type to include SEMI_FINISHED
    await q.query(`ALTER TABLE items DROP CONSTRAINT IF EXISTS items_item_type_check`);
    await q.query(`ALTER TABLE items ADD CONSTRAINT items_item_type_check CHECK (item_type IN ('MATERIAL','SEMI_FINISHED','FINISHED_GOOD'))`);

    // material_parameters
    await q.query(`
      CREATE TABLE IF NOT EXISTS material_parameters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        parameter_name varchar(100) NOT NULL,
        parameter_value varchar(300) NOT NULL,
        unit varchar(50),
        remark varchar(200),
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_material_parameters_material ON material_parameters(material_id, sort_order)`);

    // material_parameter_templates
    await q.query(`
      CREATE TABLE IF NOT EXISTS material_parameter_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id uuid REFERENCES item_categories(id),
        name varchar(100) NOT NULL,
        parameters jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ===  Phase 3: BOM Archive ===

    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS effective_date date`);
    await q.query(`ALTER TABLE boms ADD COLUMN IF NOT EXISTS expiry_date date`);
    await q.query(`ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS loss_rate numeric(8,4) NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS alternative_material_id uuid REFERENCES items(id)`);
    await q.query(`ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS remark varchar(200)`);

    // ===  Phase 3: Warehouse Archive ===

    await q.query(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS display_name varchar(100)`);
    await q.query(`UPDATE warehouses SET display_name = name WHERE display_name IS NULL`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS warehouse_racks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id),
        zone_id uuid NOT NULL REFERENCES warehouse_zones(id),
        code varchar(50) NOT NULL,
        name varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(warehouse_id, code)
      )
    `);

    await q.query(`ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS rack_id uuid REFERENCES warehouse_racks(id)`);
    await q.query(`ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS layer integer`);
    await q.query(`ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS col_pos integer`);
    await q.query(`ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS position_desc varchar(200)`);
    await q.query(`ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS allowed_categories jsonb`);
    await q.query(`ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS allow_mixed boolean NOT NULL DEFAULT true`);
    await q.query(`ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS capacity numeric(18,4)`);

    // ===  Phase 4: Virtual Warehouse ===

    await q.query(`
      CREATE TABLE IF NOT EXISTS warehouse_layouts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id),
        layout_name varchar(100) NOT NULL,
        layout_type varchar(30) NOT NULL DEFAULT '2D',
        background_image text,
        canvas_width integer NOT NULL DEFAULT 1200,
        canvas_height integer NOT NULL DEFAULT 800,
        version integer NOT NULL DEFAULT 1,
        status varchar(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
        created_by_user_id uuid REFERENCES users(id),
        created_by_username varchar(50),
        created_by_name varchar(100),
        published_by_user_id uuid REFERENCES users(id),
        published_by_username varchar(50),
        published_by_name varchar(100),
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS warehouse_visual_nodes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        layout_id uuid NOT NULL REFERENCES warehouse_layouts(id) ON DELETE CASCADE,
        node_type varchar(30) NOT NULL CHECK (node_type IN ('ZONE','RACK','LOCATION','AISLE','ENTRANCE')),
        business_id uuid,
        parent_node_id uuid REFERENCES warehouse_visual_nodes(id),
        code varchar(50) NOT NULL,
        name varchar(100),
        x double precision NOT NULL DEFAULT 0,
        y double precision NOT NULL DEFAULT 0,
        width double precision NOT NULL DEFAULT 100,
        height double precision NOT NULL DEFAULT 100,
        rotation double precision NOT NULL DEFAULT 0,
        layer integer NOT NULL DEFAULT 0,
        style_config jsonb,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ===  Phase 3: stock_balances frozen_qty ===

    await q.query(`ALTER TABLE stock_balances ADD COLUMN IF NOT EXISTS frozen_qty numeric(18,4) NOT NULL DEFAULT 0`);

    // ===  Phase 12: Unified audit log ===

    await q.query(`
      CREATE TABLE IF NOT EXISTS business_operation_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        module varchar(50) NOT NULL,
        business_type varchar(80) NOT NULL,
        business_id uuid,
        business_no varchar(100),
        action varchar(50) NOT NULL,
        action_description varchar(200),
        operator_user_id uuid REFERENCES users(id),
        operator_username varchar(50),
        operator_name varchar(100),
        operator_department varchar(100),
        before_data jsonb,
        after_data jsonb,
        change_fields jsonb,
        reason varchar(500),
        ip_address varchar(50),
        user_agent varchar(300),
        request_id varchar(50),
        operation_result varchar(20) NOT NULL DEFAULT 'SUCCESS',
        failure_reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_business_log_business ON business_operation_logs(business_type, business_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_business_log_operator ON business_operation_logs(operator_user_id, created_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_business_log_module ON business_operation_logs(module, action, created_at DESC)`);

    // operation_logs enhancements
    await q.query(`ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS operator_username varchar(50)`);
    await q.query(`ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS operator_name varchar(100)`);
    await q.query(`ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS operator_department varchar(100)`);

    // Backfill operation_logs
    await q.query(`
      UPDATE operation_logs o SET
        operator_username = u.username,
        operator_name = u.employee_name,
        operator_department = u.department
      FROM users u WHERE u.id = o.user_id AND o.operator_username IS NULL
    `);

    // ===  Production Order Enhancements ===

    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS responsible_by uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS responsible_username varchar(50)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS responsible_name varchar(100)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS released_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS released_by_username varchar(50)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS released_by_name varchar(100)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS shortage_checked_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS shortage_checked_by_username varchar(50)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS force_released_by_user_id uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS force_released_by_username varchar(50)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS force_released_by_name varchar(100)`);
    await q.query(`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS force_release_reason varchar(500)`);

    // Relax production_orders status check for new states
    await q.query(`ALTER TABLE production_orders DROP CONSTRAINT IF EXISTS production_orders_status_check`);
    await q.query(`ALTER TABLE production_orders ADD CONSTRAINT production_orders_status_check CHECK (status IN ('DRAFT','RELEASED','AWAITING_ISSUE','IN_PROGRESS','AWAITING_COMPLETION','COMPLETED','CLOSED','CANCELLED'))`);

    // ===  Material snapshot on stock_document_lines ===
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS material_snapshot jsonb`);

    // ===  New permissions ===
    const newPermissions = [
      'warehouse.virtual.view','warehouse.virtual.operate','warehouse.layout.edit',
      'material.parameter.manage',
      'production.force_release',
      'stock.putaway','stock.pick','stock.review','stock.move','stock.count',
      'stock.adjust','stock.freeze','stock.export','stock.reconcile',
      'document.approve','document.reverse_approve','document.void',
      'system.version.manage',
    ];
    for (const code of newPermissions) {
      await q.query(`INSERT INTO permissions(code,name) VALUES($1,$2) ON CONFLICT(code) DO NOTHING`, [code, code]);
    }
    // Grant new permissions to ADMIN
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
      WHERE r.code='ADMIN' AND p.code = ANY($1)
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `, [newPermissions]);

    console.log('V110Refactor migration applied successfully');
  }

  async down(q: QueryRunner): Promise<void> {
    console.log('Starting V110Refactor rollback...');

    // Drop new tables
    await q.query(`DROP TABLE IF EXISTS business_operation_logs`);
    await q.query(`DROP TABLE IF EXISTS warehouse_visual_nodes`);
    await q.query(`DROP TABLE IF EXISTS warehouse_layouts`);
    await q.query(`DROP TABLE IF EXISTS material_parameter_templates`);
    await q.query(`DROP TABLE IF EXISTS material_parameters`);
    await q.query(`DROP TABLE IF EXISTS warehouse_racks`);

    // Remove added columns from items
    const itemCols = ['brand','model','spec','default_warehouse_id','default_zone_id','enable_batch','created_by_user_id','created_by_username','created_by_name','created_by_department','updated_by_user_id','updated_by_username','updated_by_name','updated_by_department','enabled_by_user_id','enabled_by_username','enabled_by_name','disabled_by_user_id','disabled_by_username','disabled_by_name','deleted_at'];
    for (const col of itemCols) await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS ${col}`);

    // Restore item_type CHECK
    await q.query(`ALTER TABLE items DROP CONSTRAINT IF EXISTS items_item_type_check`);
    await q.query(`ALTER TABLE items ADD CONSTRAINT items_item_type_check CHECK (item_type IN ('MATERIAL','FINISHED_GOOD'))`);

    // Remove columns from boms
    const bomCols = ['effective_date','expiry_date','created_by_user_id','created_by_username','created_by_name','updated_by_user_id','updated_by_username','updated_by_name','enabled_by_user_id','enabled_by_username','enabled_by_name','disabled_by_user_id','disabled_by_username','disabled_by_name','deleted_at'];
    for (const col of bomCols) await q.query(`ALTER TABLE boms DROP COLUMN IF EXISTS ${col}`);

    // Remove columns from bom_items
    await q.query(`ALTER TABLE bom_items DROP COLUMN IF EXISTS loss_rate`);
    await q.query(`ALTER TABLE bom_items DROP COLUMN IF EXISTS alternative_material_id`);
    await q.query(`ALTER TABLE bom_items DROP COLUMN IF EXISTS remark`);

    // Remove columns from warehouses
    await q.query(`ALTER TABLE warehouses DROP COLUMN IF EXISTS display_name`);

    // Remove columns from warehouse_locations
    const locCols = ['rack_id','layer','col_pos','position_desc','allowed_categories','allow_mixed','capacity'];
    for (const col of locCols) await q.query(`ALTER TABLE warehouse_locations DROP COLUMN IF EXISTS ${col}`);

    // Remove columns from stock_documents
    const docCols = ['created_by_user_id','created_by_username','created_by_name','created_by_department','submitted_by_user_id','submitted_by_username','submitted_by_name','approved_by_user_id','approved_by_username','approved_by_name','rejected_by_user_id','rejected_by_username','rejected_by_name','voided_by_user_id','voided_by_username','voided_by_name','posted_by_user_id','posted_by_username','posted_by_name','withdrawn_by_user_id','withdrawn_by_username','withdrawn_by_name','deleted_at'];
    for (const col of docCols) await q.query(`ALTER TABLE stock_documents DROP COLUMN IF EXISTS ${col}`);

    // Remove columns from stock_transactions
    await q.query(`ALTER TABLE stock_transactions DROP COLUMN IF EXISTS operator_username`);
    await q.query(`ALTER TABLE stock_transactions DROP COLUMN IF EXISTS operator_name`);
    await q.query(`ALTER TABLE stock_transactions DROP COLUMN IF EXISTS operator_department`);
    await q.query(`ALTER TABLE stock_transactions DROP COLUMN IF EXISTS request_id`);

    // Remove columns from users
    const userCols = ['employee_name','employee_no','department','position','phone','email','last_login_at','deleted_at','remarks'];
    for (const col of userCols) await q.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${col}`);

    // Remove columns from operation_logs
    await q.query(`ALTER TABLE operation_logs DROP COLUMN IF EXISTS operator_username`);
    await q.query(`ALTER TABLE operation_logs DROP COLUMN IF EXISTS operator_name`);
    await q.query(`ALTER TABLE operation_logs DROP COLUMN IF EXISTS operator_department`);

    // Remove columns from production_orders
    const poCols = ['responsible_by','responsible_username','responsible_name','released_by_user_id','released_by_username','released_by_name','shortage_checked_by_user_id','shortage_checked_by_username','force_released_by_user_id','force_released_by_username','force_released_by_name','force_release_reason'];
    for (const col of poCols) await q.query(`ALTER TABLE production_orders DROP COLUMN IF EXISTS ${col}`);

    // Restore production_orders status check
    await q.query(`ALTER TABLE production_orders DROP CONSTRAINT IF EXISTS production_orders_status_check`);
    await q.query(`ALTER TABLE production_orders ADD CONSTRAINT production_orders_status_check CHECK (status IN ('DRAFT','RELEASED','IN_PROGRESS','COMPLETED','CANCELLED'))`);

    // Remove from stock_balances
    await q.query(`ALTER TABLE stock_balances DROP COLUMN IF EXISTS frozen_qty`);
    await q.query(`ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS material_snapshot`);

    console.log('V110Refactor rollback complete');
  }
}
