import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { createDataSource } from './data-source';

export async function seedDatabase(db: DataSource, includeMasterData = true) {
  const initialPassword = process.env.INITIAL_DEMO_PASSWORD || 'Demo@123456';
  if (initialPassword.length < 8) throw new Error('INITIAL_DEMO_PASSWORD must contain at least 8 characters');
  const passwordHash = await bcrypt.hash(initialPassword, 12);
  const users = [
    ['admin', '系统管理员', 'ADMIN'],
    ['warehouse', '仓库管理员', 'WAREHOUSE'],
    ['production', '生产人员', 'PRODUCTION'],
  ];
  const createdUsers = new Set<string>();
  for (const [username, name, role] of users) {
    const created = await db.query(`INSERT INTO users(username,name,password_hash,role,role_id,employee_name)
      SELECT $1,$2,$3,$4,id,$2 FROM roles WHERE code=$5
      ON CONFLICT(username) DO NOTHING
      RETURNING username`,
      [username, name, passwordHash, role, role]);
    if (created[0]?.username) createdUsers.add(created[0].username);
  }
  const [admin] = await db.query(`SELECT id FROM users WHERE username='admin'`);
  if (createdUsers.has('admin')) {
    await db.query(`UPDATE users SET position_type='SYSTEM_ADMIN',can_approve=true,department_name='系统管理部' WHERE username='admin'`);
  }
  if (createdUsers.has('warehouse')) {
    await db.query(`UPDATE users SET position_type='WAREHOUSE_MANAGER',manager_user_id=$1,department_name='仓储部',can_approve=false WHERE username='warehouse'`, [admin.id]);
  }
  if (createdUsers.has('production')) {
    await db.query(`UPDATE users SET position_type='PRODUCTION',manager_user_id=$1,department_name='生产部',can_approve=false WHERE username='production'`, [admin.id]);
  }

  if (await shouldInitialize(db, 'base_warehouses_v1', 'warehouses')) {
    await db.query(`INSERT INTO warehouses(warehouse_code,name,display_name,warehouse_type) VALUES
      ('RAW','原材料库','原材料库','RAW'),('FG','成品库','成品库','FG')
      ON CONFLICT(warehouse_code) DO NOTHING`);
    await db.query(`INSERT INTO warehouse_zones(warehouse_id,sequence_no,code,name,actual_location)
      SELECT id,1,warehouse_code||'01','主库区','未填写' FROM warehouses
      WHERE warehouse_code IN ('RAW','FG')
      ON CONFLICT(warehouse_id,sequence_no) DO NOTHING`);
    await db.query(`INSERT INTO warehouse_locations(warehouse_id,zone_id,code,name,system_default)
      SELECT w.id,z.id,z.code||'-DEFAULT','内部默认库位',true FROM warehouses w
      JOIN warehouse_zones z ON z.warehouse_id=w.id AND z.sequence_no=1
      WHERE w.warehouse_code IN ('RAW','FG')
      ON CONFLICT(warehouse_id,code) DO NOTHING`);
    await markInitialized(db, 'base_warehouses_v1');
  }
  // The defective warehouse is required by receipt approval and must also be
  // created for databases whose original base-warehouse seed already ran.
  await db.query(`INSERT INTO warehouses(warehouse_code,name,display_name,warehouse_type,status) VALUES
    ('DEFECTIVE','不良品库','不良品库','DEFECTIVE','ACTIVE')
    ON CONFLICT(warehouse_code) DO UPDATE SET warehouse_type='DEFECTIVE'`);
  await db.query(`INSERT INTO warehouse_zones(warehouse_id,sequence_no,code,name,actual_location,status)
    SELECT id,1,'DEFECTIVE01','主库区','未填写','ACTIVE' FROM warehouses WHERE warehouse_code='DEFECTIVE'
    ON CONFLICT(warehouse_id,sequence_no) DO NOTHING`);
  await db.query(`INSERT INTO warehouse_locations(warehouse_id,zone_id,code,name,system_default,status)
    SELECT w.id,z.id,'DEFECTIVE01-DEFAULT','内部默认库位',true,'ACTIVE' FROM warehouses w
    JOIN warehouse_zones z ON z.warehouse_id=w.id AND z.sequence_no=1
    WHERE w.warehouse_code='DEFECTIVE'
    ON CONFLICT(warehouse_id,code) DO NOTHING`);
  await db.query(`INSERT INTO warehouse_manager(warehouse_id,user_id,created_by)
    SELECT w.id,u.id,$1 FROM warehouses w JOIN users u ON u.username='warehouse' WHERE w.warehouse_code IN ('RAW','FG','DEFECTIVE')
    ON CONFLICT(warehouse_id,user_id) DO NOTHING`, [admin.id]);
  if (!includeMasterData) return;

  if (await shouldInitialize(db, 'demo_master_data_v1', 'items')) {
    const items = [
      ['M-001', '电机', 'MATERIAL', '个'], ['M-002', '外壳', 'MATERIAL', '个'],
      ['M-003', '螺丝', 'MATERIAL', '个'], ['FG-001', '监测终端', 'FINISHED_GOOD', '台'],
    ];
    for (const row of items) {
      await db.query(`INSERT INTO units(code,name) VALUES(upper(substr(md5($1),1,12)),$1) ON CONFLICT(code) DO NOTHING`, [row[3]]);
      await db.query(`INSERT INTO items(item_code,name,item_type,unit,unit_id,category_id)
        SELECT $1,$2,$3::varchar,$4::varchar,u.id,NULL FROM units u
        WHERE u.name=$4::varchar
        ON CONFLICT(item_code) DO NOTHING`, row);
    }
    const [fg] = await db.query(`SELECT id FROM items WHERE item_code='FG-001'`);
    if (fg) {
      let [bom] = await db.query(`SELECT id FROM boms WHERE finished_good_id=$1 AND version='V1' AND deleted_at IS NULL`, [fg.id]);
      if (!bom) {
        [bom] = await db.query(`INSERT INTO boms(finished_good_id,version,status,notes) VALUES($1,'V1','ACTIVE','MVP验收BOM') RETURNING id`, [fg.id]);
      }
      for (const [code, qty] of [['M-001', '1'], ['M-002', '1'], ['M-003', '4']]) {
        const [material] = await db.query(`SELECT id FROM items WHERE item_code=$1`, [code]);
        if (material) {
          await db.query(`INSERT INTO bom_items(bom_id,material_id,qty_per) VALUES($1,$2,$3)
            ON CONFLICT(bom_id,material_id) DO UPDATE SET qty_per=EXCLUDED.qty_per`, [bom.id, material.id, qty]);
        }
      }
    }
    await markInitialized(db, 'demo_master_data_v1');
  }
}

async function shouldInitialize(db: DataSource, key: string, table: string) {
  const [state] = await db.query(`SELECT key FROM system_seed_state WHERE key=$1`, [key]);
  if (state) return false;
  const [{ count } = { count: 0 }] = await db.query(`SELECT count(*)::int count FROM ${table}`);
  if (count > 0) {
    await markInitialized(db, key);
    return false;
  }
  return true;
}

async function markInitialized(db: DataSource, key: string) {
  await db.query(`INSERT INTO system_seed_state(key) VALUES($1) ON CONFLICT(key) DO NOTHING`, [key]);
}

async function run() {
  const db = createDataSource();
  await db.initialize();
  await seedDatabase(db, true);
  console.log('Seed complete: admin, warehouse, production, RAW, FG, acceptance master data');
  await db.destroy();
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
