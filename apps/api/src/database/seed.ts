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
  for (const [username, name, role] of users) {
    await db.query(`INSERT INTO users(username,name,password_hash,role) VALUES($1,$2,$3,$4)
      ON CONFLICT(username) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role`, [username, name, passwordHash, role]);
  }
  await db.query(`INSERT INTO warehouses(warehouse_code,name,warehouse_type) VALUES
    ('RAW','原材料库','RAW'),('FG','成品库','FG') ON CONFLICT(warehouse_code) DO UPDATE SET name=EXCLUDED.name`);
  if (!includeMasterData) return;

  const items = [
    ['M-001', '电机', 'MATERIAL', '个'], ['M-002', '外壳', 'MATERIAL', '个'],
    ['M-003', '螺丝', 'MATERIAL', '个'], ['FG-001', '监测终端', 'FINISHED_GOOD', '台'],
  ];
  for (const row of items) {
    await db.query(`INSERT INTO items(item_code,name,item_type,unit) VALUES($1,$2,$3,$4)
      ON CONFLICT(item_code) DO UPDATE SET name=EXCLUDED.name, item_type=EXCLUDED.item_type, unit=EXCLUDED.unit`, row);
  }
  const [fg] = await db.query(`SELECT id FROM items WHERE item_code='FG-001'`);
  let [bom] = await db.query(`SELECT id FROM boms WHERE finished_good_id=$1 AND version='V1'`, [fg.id]);
  if (!bom) {
    [bom] = await db.query(`INSERT INTO boms(finished_good_id,version,status,notes) VALUES($1,'V1','ACTIVE','MVP验收BOM') RETURNING id`, [fg.id]);
  }
  for (const [code, qty] of [['M-001', '1'], ['M-002', '1'], ['M-003', '4']]) {
    const [material] = await db.query(`SELECT id FROM items WHERE item_code=$1`, [code]);
    await db.query(`INSERT INTO bom_items(bom_id,material_id,qty_per) VALUES($1,$2,$3)
      ON CONFLICT(bom_id,material_id) DO UPDATE SET qty_per=EXCLUDED.qty_per`, [bom.id, material.id, qty]);
  }
}

async function run() {
  const db = createDataSource();
  await db.initialize();
  await seedDatabase(db, true);
  console.log('Seed complete: admin, warehouse, production, RAW, FG, acceptance master data');
  await db.destroy();
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
