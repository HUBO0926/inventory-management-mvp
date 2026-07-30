import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1710000000000 } from '../src/database/migrations/1710000000000-InitialSchema';
import { DashboardIndexes1720000000000 } from '../src/database/migrations/1720000000000-DashboardIndexes';
import { FinishedInbound1730000000000 } from '../src/database/migrations/1730000000000-FinishedInbound';
import { V110Foundation1740000000000 } from '../src/database/migrations/1740000000000-V110Foundation';
import { V110Refactor1750000000000 } from '../src/database/migrations/1750000000000-V110Refactor';
import { ItemArchiveImages1760000000000 } from '../src/database/migrations/1760000000000-ItemArchiveImages';
import { ItemCategoryTypes1770000000000 } from '../src/database/migrations/1770000000000-ItemCategoryTypes';
import { MasterDataFlexibility1780000000000 } from '../src/database/migrations/1780000000000-MasterDataFlexibility';
import { DefectiveWarehouseAndMove1790000000000 } from '../src/database/migrations/1790000000000-DefectiveWarehouseAndMove';
import { VirtualWarehousePermissions1800000000000 } from '../src/database/migrations/1800000000000-VirtualWarehousePermissions';
import { WarehouseLocationManagement1810000000000 } from '../src/database/migrations/1810000000000-WarehouseLocationManagement';
import { ApprovalCenter1820000000000 } from '../src/database/migrations/1820000000000-ApprovalCenter';
import { ApprovalHistoryDocumentRetention1830000000000 } from '../src/database/migrations/1830000000000-ApprovalHistoryDocumentRetention';
import { ProductionPicking1840000000000 } from '../src/database/migrations/1840000000000-ProductionPicking';
import { InventoryManagement1850000000000 } from '../src/database/migrations/1850000000000-InventoryManagement';
import { IntegerQuantityDefectiveProcessing1860000000000 } from '../src/database/migrations/1860000000000-IntegerQuantityDefectiveProcessing';

const baseConnection = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5434),
  username: process.env.POSTGRES_USER || 'inventory',
  password: process.env.POSTGRES_PASSWORD || 'inventory_dev',
};
const upgradeDatabase = process.env.UPGRADE_TEST_DB || 'inventory_upgrade_test';
if (!/^[a-zA-Z0-9_]+$/.test(upgradeDatabase)) throw new Error('UPGRADE_TEST_DB contains invalid characters');
const connection = process.env.UPGRADE_TEST_DATABASE_URL
  ? { url: process.env.UPGRADE_TEST_DATABASE_URL }
  : { ...baseConnection, database: upgradeDatabase };

async function run() {
  let adminConnection:DataSource|undefined;
  if (!process.env.UPGRADE_TEST_DATABASE_URL) {
    adminConnection=new DataSource({type:'postgres',...baseConnection,database:'postgres'});
    await adminConnection.initialize();
    await adminConnection.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,[upgradeDatabase]);
    await adminConnection.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`);
    await adminConnection.query(`CREATE DATABASE "${upgradeDatabase}"`);
  }
  const legacy = new DataSource({ type: 'postgres', ...connection, migrations: [InitialSchema1710000000000, DashboardIndexes1720000000000, FinishedInbound1730000000000] });
  await legacy.initialize();
  await legacy.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await legacy.runMigrations();
  await legacy.query(`
    INSERT INTO users(username,name,password_hash,role) VALUES('legacy-admin','旧管理员','hash','ADMIN');
    INSERT INTO warehouses(warehouse_code,name,warehouse_type) VALUES('RAW','原材料库','RAW'),('FG','成品库','FG');
    INSERT INTO items(item_code,name,item_type,unit) VALUES('LEGACY-M','旧物料','MATERIAL','个');
    INSERT INTO stock_documents(document_no,document_type,status,warehouse_id,created_by,posted_by,posted_at)
      SELECT 'MI-LEGACY','MATERIAL_INBOUND','POSTED',w.id,u.id,u.id,now() FROM warehouses w CROSS JOIN users u WHERE w.warehouse_code='RAW';
    INSERT INTO stock_document_lines(document_id,item_id,quantity,direction)
      SELECT d.id,i.id,5,'IN' FROM stock_documents d CROSS JOIN items i;
    INSERT INTO stock_balances(warehouse_id,item_id,on_hand_qty)
      SELECT w.id,i.id,5 FROM warehouses w CROSS JOIN items i WHERE w.warehouse_code='RAW';
    INSERT INTO stock_transactions(source_document_id,warehouse_id,item_id,delta_qty,balance_after,created_by)
      SELECT d.id,w.id,i.id,5,5,u.id FROM stock_documents d CROSS JOIN warehouses w CROSS JOIN items i CROSS JOIN users u WHERE w.warehouse_code='RAW';
  `);
  await legacy.destroy();

  const upgraded = new DataSource({ type: 'postgres', ...connection, migrations: [
    InitialSchema1710000000000,DashboardIndexes1720000000000,FinishedInbound1730000000000,
    V110Foundation1740000000000,
  ] });
  await upgraded.initialize();
  const executed = await upgraded.runMigrations();
  if (!executed.some(migration => migration.name === 'V110Foundation1740000000000')) throw new Error('V1.1.0 migration was not executed');
  const [unit] = await upgraded.query(`SELECT id,name FROM units LIMIT 1`);
  await upgraded.query(`ALTER TABLE items DROP CONSTRAINT IF EXISTS items_item_type_check`);
  await upgraded.query(`ALTER TABLE items ADD CONSTRAINT items_item_type_check CHECK(item_type IN ('MATERIAL','SEMI_FINISHED','FINISHED_GOOD'))`);
  const [shared] = await upgraded.query(`INSERT INTO item_categories(code,name) VALUES('SHARED','共享历史分类') RETURNING id`);
  await upgraded.query(`UPDATE items SET category_id=$1 WHERE item_code='LEGACY-M'`,[shared.id]);
  await upgraded.query(
    `INSERT INTO items(item_code,name,item_type,unit,unit_id,category_id)
     VALUES('LEGACY-S','旧半成品','SEMI_FINISHED',$1,$2,$3),
       ('LEGACY-F','旧成品','FINISHED_GOOD',$1,$2,$3)`,
    [unit.name,unit.id,shared.id],
  );
  await upgraded.query(`INSERT INTO item_categories(code,name) VALUES('UNUSED','未引用历史分类')`);
  await upgraded.destroy();

  const final = new DataSource({ type: 'postgres', ...connection, migrations: [
    InitialSchema1710000000000,DashboardIndexes1720000000000,FinishedInbound1730000000000,
    V110Foundation1740000000000,V110Refactor1750000000000,ItemArchiveImages1760000000000,
    ItemCategoryTypes1770000000000,MasterDataFlexibility1780000000000,
    DefectiveWarehouseAndMove1790000000000,VirtualWarehousePermissions1800000000000,
    WarehouseLocationManagement1810000000000,ApprovalCenter1820000000000,
    ApprovalHistoryDocumentRetention1830000000000,ProductionPicking1840000000000,
    InventoryManagement1850000000000,IntegerQuantityDefectiveProcessing1860000000000,
  ] });
  await final.initialize();
  const categoryMigrations = await final.runMigrations();
  if (!categoryMigrations.some(migration => migration.name === 'ItemCategoryTypes1770000000000')) throw new Error('Category type migration was not executed');
  if (!categoryMigrations.some(migration => migration.name === 'MasterDataFlexibility1780000000000')) throw new Error('Master data flexibility migration was not executed');
  if (!categoryMigrations.some(migration => migration.name === 'IntegerQuantityDefectiveProcessing1860000000000')) throw new Error('Integer quantity and defective processing migration was not executed');
  const [row] = await final.query(`
    SELECT i.unit_id,i.category_id,u.role_id,b.location_id,t.location_id transaction_location,
      t.balance_before,d.status
    FROM items i CROSS JOIN users u CROSS JOIN stock_balances b CROSS JOIN stock_transactions t CROSS JOIN stock_documents d
    WHERE i.item_code='LEGACY-M' AND u.username='legacy-admin' AND d.document_no='MI-LEGACY'
  `);
  if (!row?.unit_id || !row?.category_id || !row?.role_id || !row?.location_id || !row?.transaction_location) throw new Error('Legacy dimensions were not backfilled');
  if (row.balance_before !== '0' || row.status !== 'POSTED') throw new Error('Legacy inventory semantics changed during upgrade');
  const [quantityColumn]=await final.query(`
    SELECT numeric_scale FROM information_schema.columns
    WHERE table_schema='public' AND table_name='stock_balances' AND column_name='on_hand_qty'
  `);
  if(Number(quantityColumn?.numeric_scale)!==0)throw new Error('Inventory quantities were not converted to integers');
  const [defectiveTables]=await final.query(`
    SELECT COUNT(*)::int AS count FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN ('defective_inventory_lots','defective_disposition_records')
  `);
  if(Number(defectiveTables?.count)!==2)throw new Error('Defective processing tables were not created');
  const sharedCategories=await final.query(`SELECT item_type FROM item_categories WHERE code='SHARED' ORDER BY item_type`);
  const unusedCategories=await final.query(`SELECT item_type FROM item_categories WHERE code='UNUSED' ORDER BY item_type`);
  if(sharedCategories.length!==3||unusedCategories.length!==3)throw new Error('Historical categories were not split into all required item types');
  const mismatches=await final.query(`SELECT i.id FROM items i JOIN item_categories c ON c.id=i.category_id WHERE i.item_type<>c.item_type`);
  if(mismatches.length)throw new Error('Item and category types do not match after upgrade');
  const protectedCategories=await final.query(`SELECT id FROM item_categories WHERE system_protected=true`);
  if(protectedCategories.length)throw new Error('Legacy categories remained system protected');
  const zones=await final.query(`SELECT z.code,z.sequence_no,z.actual_location,l.system_default
    FROM warehouse_zones z JOIN warehouse_locations l ON l.zone_id=z.id AND l.system_default=true
    ORDER BY z.code`);
  if(zones.length!==2||zones.some((zone:any)=>!zone.sequence_no||!zone.actual_location||!zone.system_default)){
    throw new Error('Warehouse zones and internal default locations were not upgraded');
  }
  console.log('V1.0.0 -> current upgrade migration verified');
  await final.destroy();
  if(adminConnection){
    await adminConnection.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,[upgradeDatabase]);
    await adminConnection.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`);
    await adminConnection.destroy();
  }
}

run().catch(error => { console.error(error); process.exit(1); });
