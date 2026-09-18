import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { BusinessNumberService } from '../common/business-number.service';
import { Direction, DocumentType } from '../common/constants';
import { InventoryPostingService } from '../inventory/posting.service';
import { StockReservationService } from '../inventory/reservation.service';
import { createDataSource } from './data-source';
import { seedDatabase } from './seed';

const DEMO_SEED_KEY = 'demo_inventory_v1';

type DemoWarehouse = { code: string; name: string; type: 'RAW' | 'FG' | 'DEFECTIVE' };

const warehouses: DemoWarehouse[] = [
  { code: 'DEMO-RAW-A', name: 'DEMO 原材料一仓', type: 'RAW' },
  { code: 'DEMO-RAW-B', name: 'DEMO 原材料二仓', type: 'RAW' },
  { code: 'DEMO-FG-A', name: 'DEMO 成品一仓', type: 'FG' },
  { code: 'DEMO-FG-B', name: 'DEMO 成品二仓', type: 'FG' },
  { code: 'DEMO-DEF', name: 'DEMO 不良品仓', type: 'DEFECTIVE' },
];

/**
 * Explicit, idempotent stock fixture. Inventory is created through the same
 * document creation and posting service used by the application, never by
 * writing balances or transactions directly.
 */
export async function seedDemoInventory(db: DataSource) {
  await seedDatabase(db, true);
  const qr = db.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    await qr.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [DEMO_SEED_KEY]);
    const [existing] = await qr.query(`SELECT key FROM system_seed_state WHERE key=$1`, [DEMO_SEED_KEY]);
    if (existing) {
      await qr.commitTransaction();
      return { created: false, message: '演示库存已生成，本次未重复累加。' };
    }

    const [admin] = await qr.query(`SELECT id FROM users WHERE username='admin' AND status='ACTIVE'`);
    if (!admin) throw new Error('缺少启用的 admin 账号，无法生成演示库存');
    await ensureWarehouses(qr, admin.id);
    const itemIds = await ensureItemsAndBom(qr);
    const locations = await loadLocations(qr);
    const batches = await ensureBatches(qr, itemIds);

    const posting = new InventoryPostingService(db, new AuditService(db), new StockReservationService(), new BusinessNumberService());
    const post = async (input: any) => {
      const doc = await posting.createDocument(qr, input, admin.id);
      return posting.applyDocument(qr, doc.id, admin.id, ['DRAFT']);
    };

    await post({
      documentType: DocumentType.MATERIAL_INBOUND, warehouseId: locations.rawA.warehouseId, notes: 'DEMO 原材料入库：跨库位、跨批次',
      lines: [
        { itemId: itemIds.m1, quantity: '900', direction: Direction.IN, locationId: locations.rawA.a01, batchId: batches.m1a },
        { itemId: itemIds.m2, quantity: '2400', direction: Direction.IN, locationId: locations.rawA.a02, batchId: batches.m2a },
        { itemId: itemIds.m3, quantity: '12000', direction: Direction.IN, locationId: locations.rawA.a03, batchId: batches.m3a },
      ],
    });
    await post({
      documentType: DocumentType.MATERIAL_INBOUND, warehouseId: locations.rawA.warehouseId, notes: 'DEMO 原材料补充批次入库',
      lines: [{ itemId: itemIds.m1, quantity: '600', direction: Direction.IN, locationId: locations.rawA.a02, batchId: batches.m1b }],
    });
    await post({
      documentType: DocumentType.STOCK_MOVE, warehouseId: locations.rawA.warehouseId, notes: 'DEMO 原材料移库：一仓至二仓',
      lines: [{ itemId: itemIds.m1, quantity: '300', direction: Direction.OUT, locationId: locations.rawA.a01, batchId: batches.m1a, targetWarehouseId: locations.rawB.warehouseId, targetLocationId: locations.rawB.b01, targetBatchId: batches.m1a }],
    });
    await post({
      documentType: DocumentType.FINISHED_INBOUND, warehouseId: locations.fgA.warehouseId, notes: 'DEMO 成品入库：跨库位、跨批次',
      lines: [{ itemId: itemIds.fg1, quantity: '500', direction: Direction.IN, locationId: locations.fgA.f01, batchId: batches.fg1a }],
    });
    await post({
      documentType: DocumentType.FINISHED_INBOUND, warehouseId: locations.fgA.warehouseId, notes: 'DEMO 成品补充批次入库',
      lines: [{ itemId: itemIds.fg1, quantity: '260', direction: Direction.IN, locationId: locations.fgA.f02, batchId: batches.fg1b }],
    });
    await post({
      documentType: DocumentType.STOCK_MOVE, warehouseId: locations.fgA.warehouseId, notes: 'DEMO 成品移库：一仓至二仓',
      lines: [{ itemId: itemIds.fg1, quantity: '150', direction: Direction.OUT, locationId: locations.fgA.f01, batchId: batches.fg1a, targetWarehouseId: locations.fgB.warehouseId, targetLocationId: locations.fgB.g01, targetBatchId: batches.fg1a }],
    });
    await post({
      documentType: DocumentType.FINISHED_OUTBOUND, warehouseId: locations.fgB.warehouseId, notes: 'DEMO 成品出库历史',
      lines: [{ itemId: itemIds.fg1, quantity: '40', direction: Direction.OUT, locationId: locations.fgB.g01, batchId: batches.fg1a }],
    });

    const [{ mismatch }] = await qr.query(`
      SELECT count(*)::int mismatch FROM (
        SELECT b.warehouse_id,b.location_id,b.item_id,b.batch_id
        FROM stock_balances b
        WHERE b.warehouse_id IN (SELECT id FROM warehouses WHERE warehouse_code LIKE 'DEMO-%')
        GROUP BY b.warehouse_id,b.location_id,b.item_id,b.batch_id,b.on_hand_qty
        HAVING b.on_hand_qty <> COALESCE((
          SELECT sum(t.delta_qty) FROM stock_transactions t
          WHERE t.warehouse_id=b.warehouse_id AND t.location_id=b.location_id AND t.item_id=b.item_id
            AND t.batch_id IS NOT DISTINCT FROM b.batch_id
        ),0)
      ) checks
    `);
    if (Number(mismatch) !== 0) throw new Error('演示库存余额与流水对账失败，事务已回滚');
    await qr.query(`INSERT INTO system_seed_state(key) VALUES($1)`, [DEMO_SEED_KEY]);
    await qr.commitTransaction();
    return { created: true, message: '演示库存已通过正式单据过账并完成余额流水对账。' };
  } catch (error) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    throw error;
  } finally {
    await qr.release();
  }
}

async function ensureWarehouses(qr: QueryRunner, adminId: string) {
  for (const warehouse of warehouses) {
    await qr.query(`INSERT INTO warehouses(warehouse_code,name,display_name,warehouse_type,status)
      VALUES($1,$2,$2,$3,'ACTIVE')
      ON CONFLICT(warehouse_code) DO UPDATE SET name=EXCLUDED.name,display_name=EXCLUDED.display_name,warehouse_type=EXCLUDED.warehouse_type,status='ACTIVE'`, [warehouse.code, warehouse.name, warehouse.type]);
    const [row] = await qr.query(`SELECT id FROM warehouses WHERE warehouse_code=$1`, [warehouse.code]);
    for (const [sequence, suffix, name] of [[1, 'A', '收发库区'], [2, 'B', '备货库区']] as const) {
      const zoneCode = `${warehouse.code}-${suffix}`;
      await qr.query(`INSERT INTO warehouse_zones(warehouse_id,sequence_no,code,name,actual_location,status)
        VALUES($1,$2,$3,$4,$4,'ACTIVE') ON CONFLICT(warehouse_id,sequence_no)
        DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,status='ACTIVE'`, [row.id, sequence, zoneCode, name]);
      const [zone] = await qr.query(`SELECT id FROM warehouse_zones WHERE warehouse_id=$1 AND sequence_no=$2`, [row.id, sequence]);
      for (const index of [1, 2]) {
        const locationCode = `${zoneCode}-${String(index).padStart(2, '0')}`;
        await qr.query(`INSERT INTO warehouse_locations(warehouse_id,zone_id,code,name,status,system_default)
          VALUES($1,$2,$3,$4,'ACTIVE',false) ON CONFLICT(warehouse_id,code)
          DO UPDATE SET zone_id=EXCLUDED.zone_id,name=EXCLUDED.name,status='ACTIVE'`, [row.id, zone.id, locationCode, `${name}${index}号库位`]);
      }
    }
    await qr.query(`INSERT INTO warehouse_manager(warehouse_id,user_id,created_by)
      SELECT $1,u.id,$2 FROM users u WHERE u.username='warehouse' AND u.status='ACTIVE'
      ON CONFLICT(warehouse_id,user_id) DO NOTHING`, [row.id, adminId]);
  }
}

async function ensureItemsAndBom(qr: QueryRunner) {
  const specs = [
    ['DEMO-M-001', 'DEMO 电机', 'MATERIAL', '个'],
    ['DEMO-M-002', 'DEMO 外壳', 'MATERIAL', '个'],
    ['DEMO-M-003', 'DEMO 紧固件', 'MATERIAL', '个'],
    ['DEMO-FG-001', 'DEMO 智能终端', 'FINISHED_GOOD', '台'],
  ] as const;
  const categories: Record<string, string> = {};
  for (const itemType of ['MATERIAL', 'FINISHED_GOOD']) {
    await qr.query(`INSERT INTO item_categories(code,name,item_type,status,sort_order,system_protected)
      VALUES('DEMO-DEFAULT','DEMO 默认分类',$1,'ACTIVE',0,false)
      ON CONFLICT(item_type,code) DO UPDATE SET status='ACTIVE'`, [itemType]);
    const [category] = await qr.query(`SELECT id FROM item_categories WHERE code='DEMO-DEFAULT' AND item_type=$1`, [itemType]);
    categories[itemType] = category.id;
  }
  for (const [code, name, itemType, unit] of specs) {
    await qr.query(`INSERT INTO units(code,name,status) VALUES(upper(substr(md5($1),1,12)),$1,'ACTIVE') ON CONFLICT(code) DO UPDATE SET status='ACTIVE'`, [unit]);
    await qr.query(`INSERT INTO items(item_code,name,item_type,unit,unit_id,category_id,minimum_stock,status)
      SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,u.id,$5::uuid,100,'ACTIVE' FROM units u WHERE u.name=$4::varchar
      ON CONFLICT(item_code) DO UPDATE SET name=EXCLUDED.name,item_type=EXCLUDED.item_type,unit=EXCLUDED.unit,unit_id=EXCLUDED.unit_id,category_id=EXCLUDED.category_id,status='ACTIVE'`, [code, name, itemType, unit, categories[itemType]]);
  }
  const rows = await qr.query(`SELECT id,item_code FROM items WHERE item_code = ANY($1::varchar[])`, [specs.map(row => row[0])]);
  const byCode = Object.fromEntries(rows.map((row: any) => [row.item_code, row.id]));
  let [bom] = await qr.query(`SELECT id FROM boms WHERE finished_good_id=$1 AND version='DEMO-V1' AND deleted_at IS NULL`, [byCode['DEMO-FG-001']]);
  if (!bom) [bom] = await qr.query(`INSERT INTO boms(finished_good_id,version,status,notes) VALUES($1,'DEMO-V1','ACTIVE','DEMO 原材料组成成品') RETURNING id`, [byCode['DEMO-FG-001']]);
  for (const [code, quantity] of [['DEMO-M-001', '1'], ['DEMO-M-002', '1'], ['DEMO-M-003', '4']] as const) {
    await qr.query(`INSERT INTO bom_items(bom_id,material_id,qty_per) VALUES($1,$2,$3)
      ON CONFLICT(bom_id,material_id) DO UPDATE SET qty_per=EXCLUDED.qty_per`, [bom.id, byCode[code], quantity]);
  }
  return { m1: byCode['DEMO-M-001'], m2: byCode['DEMO-M-002'], m3: byCode['DEMO-M-003'], fg1: byCode['DEMO-FG-001'] };
}

async function ensureBatches(qr: QueryRunner, itemIds: Record<string, string>) {
  const specs = [
    ['m1a', itemIds.m1, 'DEMO-M1-202609-A'], ['m1b', itemIds.m1, 'DEMO-M1-202609-B'],
    ['m2a', itemIds.m2, 'DEMO-M2-202609-A'], ['m3a', itemIds.m3, 'DEMO-M3-202609-A'],
    ['fg1a', itemIds.fg1, 'DEMO-FG1-202609-A'], ['fg1b', itemIds.fg1, 'DEMO-FG1-202609-B'],
  ] as const;
  const result: Record<string, string> = {};
  for (const [key, itemId, batchNo] of specs) {
    await qr.query(`INSERT INTO inventory_batches(item_id,batch_no,notes,status) VALUES($1,$2,'演示库存批次','ACTIVE')
      ON CONFLICT(item_id,batch_no) DO UPDATE SET status='ACTIVE'`, [itemId, batchNo]);
    const [batch] = await qr.query(`SELECT id FROM inventory_batches WHERE item_id=$1 AND batch_no=$2`, [itemId, batchNo]);
    result[key] = batch.id;
  }
  return result;
}

async function loadLocations(qr: QueryRunner) {
  const result: Record<string, any> = {};
  for (const [key, code] of [['rawA', 'DEMO-RAW-A'], ['rawB', 'DEMO-RAW-B'], ['fgA', 'DEMO-FG-A'], ['fgB', 'DEMO-FG-B']] as const) {
    const [warehouse] = await qr.query(`SELECT id FROM warehouses WHERE warehouse_code=$1`, [code]);
    const locations = await qr.query(`SELECT id,code FROM warehouse_locations WHERE warehouse_id=$1 ORDER BY code`, [warehouse.id]);
    result[key] = { warehouseId: warehouse.id, a01: locations[0]?.id, a02: locations[1]?.id, a03: locations[2]?.id, b01: locations[0]?.id, f01: locations[0]?.id, f02: locations[1]?.id, g01: locations[0]?.id };
  }
  if (Object.values(result).some((value: any) => !value.warehouseId || !value.a01)) throw new Error('DEMO 仓库库位创建失败');
  return result as { rawA: any; rawB: any; fgA: any; fgB: any };
}

async function run() {
  const db = createDataSource();
  await db.initialize();
  try {
    console.log((await seedDemoInventory(db)).message);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
