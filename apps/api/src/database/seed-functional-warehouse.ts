import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { BusinessNumberService } from '../common/business-number.service';
import { Direction, DocumentType } from '../common/constants';
import { InventoryPostingService } from '../inventory/posting.service';
import { StockReservationService } from '../inventory/reservation.service';
import { createDataSource } from './data-source';
import { seedDatabase } from './seed';

const SEED_KEY = 'functional_warehouse_v1';
const V2_SEED_KEY = 'functional_warehouse_v2';
const PREFIX = 'TEST-FUNC';

type Locations = Record<string, { warehouseId: string; zoneA: string; zoneB: string; a01: string; a02: string; b01: string; b02: string }>;

/**
 * Persistent, idempotent functional-test fixture. It never writes stock
 * balances directly: all opening stock is represented by immutable documents
 * and stock transactions created through the shared posting service.
 */
export async function seedFunctionalWarehouse(db: DataSource) {
  await seedDatabase(db, true);
  const qr = db.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    await qr.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [SEED_KEY]);
    const [existing] = await qr.query(`SELECT key FROM system_seed_state WHERE key=$1`, [SEED_KEY]);
    const [admin] = await qr.query(`SELECT id FROM users WHERE username='admin' AND status='ACTIVE'`);
    if (!admin) throw new Error('缺少 admin 用户，无法生成 TEST-FUNC 数据');
    const locations = await ensureWarehouses(qr, admin.id);
    await ensureLimitedWarehouseManager(qr, admin.id, locations.rawA.warehouseId);
    const items = await ensureItems(qr);
    const batches = await ensureBatches(qr, items);
    const posting = new InventoryPostingService(db, new AuditService(db), new StockReservationService(), new BusinessNumberService());
    const post = async (input: any) => {
      const doc = await posting.createDocument(qr, input, admin.id);
      return posting.applyDocument(qr, doc.id, admin.id, ['DRAFT']);
    };

    if (!existing) {
    await post({ documentType: DocumentType.MATERIAL_INBOUND, warehouseId: locations.rawA.warehouseId, notes: `${PREFIX} 基础原材料入库 A 批次`, lines: [
      { itemId: items.motor, quantity: '150', direction: Direction.IN, locationId: locations.rawA.a01, batchId: batches.motorA },
      { itemId: items.shell, quantity: '80', direction: Direction.IN, locationId: locations.rawA.b01, batchId: batches.shellA },
      { itemId: items.bolt, quantity: '100', direction: Direction.IN, locationId: locations.rawA.b02, batchId: batches.boltA },
      { itemId: items.resin, quantity: '35', direction: Direction.IN, locationId: locations.rawA.a01, batchId: batches.resinA },
    ] });
    await post({ documentType: DocumentType.MATERIAL_INBOUND, warehouseId: locations.rawA.warehouseId, notes: `${PREFIX} 基础原材料入库 B 批次`, lines: [
      { itemId: items.motor, quantity: '60', direction: Direction.IN, locationId: locations.rawA.a02, batchId: batches.motorB },
    ] });
    await post({ documentType: DocumentType.STOCK_MOVE, warehouseId: locations.rawA.warehouseId, notes: `${PREFIX} 原材料跨仓历史移库`, lines: [
      { itemId: items.motor, quantity: '20', direction: Direction.OUT, locationId: locations.rawA.a01, batchId: batches.motorA, targetWarehouseId: locations.rawB.warehouseId, targetLocationId: locations.rawB.a01, targetBatchId: batches.motorA },
    ] });
    await post({ documentType: DocumentType.FINISHED_INBOUND, warehouseId: locations.fgA.warehouseId, notes: `${PREFIX} 成品入库 A 批次`, lines: [
      { itemId: items.device, quantity: '70', direction: Direction.IN, locationId: locations.fgA.a01, batchId: batches.deviceA },
    ] });
    await post({ documentType: DocumentType.FINISHED_INBOUND, warehouseId: locations.fgA.warehouseId, notes: `${PREFIX} 成品入库 B 批次`, lines: [
      { itemId: items.device, quantity: '30', direction: Direction.IN, locationId: locations.fgA.a02, batchId: batches.deviceB },
    ] });
    await post({ documentType: DocumentType.STOCK_MOVE, warehouseId: locations.fgA.warehouseId, notes: `${PREFIX} 成品跨仓历史移库`, lines: [
      { itemId: items.device, quantity: '15', direction: Direction.OUT, locationId: locations.fgA.a01, batchId: batches.deviceA, targetWarehouseId: locations.fgB.warehouseId, targetLocationId: locations.fgB.a01, targetBatchId: batches.deviceA },
    ] });
    await post({ documentType: DocumentType.FINISHED_OUTBOUND, warehouseId: locations.fgB.warehouseId, notes: `${PREFIX} 成品历史出库`, lines: [
      { itemId: items.device, quantity: '5', direction: Direction.OUT, locationId: locations.fgB.a01, batchId: batches.deviceA },
    ] });

    await qr.query(`INSERT INTO location_item_capacities(location_id,item_id,capacity,notes) VALUES
      ($1,$2,100,$3),($4,$5,100,$6)
      ON CONFLICT(location_id,item_id) DO UPDATE SET capacity=EXCLUDED.capacity,notes=EXCLUDED.notes`, [
      locations.rawA.b01, items.shell, `${PREFIX} 容量预警 80%`,
      locations.rawA.b02, items.bolt, `${PREFIX} 满库 100%`,
    ]);
    await qr.query(`INSERT INTO location_item_rules(location_id,item_id,allowed,notes,created_by,created_by_username,created_by_name,updated_by,updated_by_username,updated_by_name)
      VALUES($1,$2,false,$3,$4,'admin','系统管理员',$4,'admin','系统管理员')
      ON CONFLICT(location_id,item_id) DO UPDATE SET allowed=false,notes=EXCLUDED.notes,updated_at=now()`, [locations.rawB.b01, items.motor, `${PREFIX} 禁止电机入库`, admin.id]);
    await qr.query(`INSERT INTO warehouse_operation_locks(scope_type,warehouse_id,zone_id,location_id,reason,locked_by,locked_by_username,locked_by_name,locked_by_department)
      VALUES('LOCATION',$1,$2,$3,$4,$5,'admin','系统管理员','系统管理部')
      ON CONFLICT DO NOTHING`, [locations.rawB.warehouseId, locations.rawB.zoneB, locations.rawB.b02, `${PREFIX} 锁定库位`, admin.id]);
    }
    const [lowStockDocument] = await qr.query(`SELECT id FROM stock_documents WHERE notes=$1`, [`${PREFIX} 低库存基准入库`]);
    if (!lowStockDocument) await post({ documentType: DocumentType.MATERIAL_INBOUND, warehouseId: locations.rawA.warehouseId, notes: `${PREFIX} 低库存基准入库`, lines: [
      { itemId: items.lowStock, quantity: '5', direction: Direction.IN, locationId: locations.rawA.a02, batchId: batches.lowStockA },
    ] });
    await qr.query(`INSERT INTO location_item_capacities(location_id,item_id,capacity,notes) VALUES
      ($1,$2,100,$3),($4,$5,100,$6),($7,$8,44,$9)
      ON CONFLICT(location_id,item_id) DO UPDATE SET capacity=EXCLUDED.capacity,notes=EXCLUDED.notes`, [
      locations.rawA.b01, items.shell, `${PREFIX} 容量预警 80%`,
      locations.rawA.b02, items.bolt, `${PREFIX} 满库 100%`,
      locations.rawA.a01, items.resin, `${PREFIX} 正常容量约 79.5%`,
    ]);
    const [v2Existing] = await qr.query(`SELECT key FROM system_seed_state WHERE key=$1`, [V2_SEED_KEY]);
    if (!v2Existing) {
      await ensureWarehouseMinimums(qr, post, locations.rawA.warehouseId, DocumentType.MATERIAL_INBOUND, `${PREFIX} V2 原材料一仓库存补足`, [
        [items.motor, batches.motorA, locations.rawA.a02], [items.shell, batches.shellA, locations.rawA.a02], [items.bolt, batches.boltA, locations.rawA.a02], [items.resin, batches.resinA, locations.rawA.a02], [items.lowStock, batches.lowStockA, locations.rawA.a02],
      ]);
      await ensureWarehouseMinimums(qr, post, locations.rawB.warehouseId, DocumentType.MATERIAL_INBOUND, `${PREFIX} V2 原材料二仓库存补足`, [
        [items.motor, batches.motorA, locations.rawB.a01], [items.shell, batches.shellA, locations.rawB.a01], [items.bolt, batches.boltA, locations.rawB.a01], [items.resin, batches.resinA, locations.rawB.a01], [items.lowStock, batches.lowStockA, locations.rawB.a01],
      ]);
      await ensureWarehouseMinimums(qr, post, locations.fgA.warehouseId, DocumentType.FINISHED_INBOUND, `${PREFIX} V2 成品一仓库存补足`, [[items.device, batches.deviceA, locations.fgA.a02]]);
      await ensureWarehouseMinimums(qr, post, locations.fgB.warehouseId, DocumentType.FINISHED_INBOUND, `${PREFIX} V2 成品二仓库存补足`, [[items.device, batches.deviceB, locations.fgB.a02]]);
      await qr.query(`INSERT INTO system_seed_state(key) VALUES($1)`, [V2_SEED_KEY]);
    }

    const [{ mismatch }] = await qr.query(`
      SELECT count(*)::int mismatch FROM stock_balances b
      WHERE b.warehouse_id IN (SELECT id FROM warehouses WHERE warehouse_code LIKE 'TEST-FUNC-%')
        AND b.on_hand_qty <> COALESCE((SELECT sum(t.delta_qty) FROM stock_transactions t
          WHERE t.warehouse_id=b.warehouse_id AND t.location_id=b.location_id AND t.item_id=b.item_id
            AND t.batch_id IS NOT DISTINCT FROM b.batch_id),0)
    `);
    if (Number(mismatch) !== 0) throw new Error('TEST-FUNC 余额与流水对账失败');
    if (!existing) await qr.query(`INSERT INTO system_seed_state(key) VALUES($1)`, [SEED_KEY]);
    await qr.commitTransaction();
    return { created: !existing, message: existing ? 'TEST-FUNC 仓储虚拟数据已校验，未重复累加基础库存。' : 'TEST-FUNC 仓储虚拟数据已通过库存单据与流水对账。' };
  } catch (error) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    throw error;
  } finally { await qr.release(); }
}

async function ensureWarehouseMinimums(qr: QueryRunner, post: (input: any) => Promise<unknown>, warehouseId: string, documentType: DocumentType, notes: string, entries: Array<[string, string, string]>) {
  const lines: any[] = [];
  for (const [itemId, batchId, locationId] of entries) {
    const [{ available }] = await qr.query(`WITH reserved AS (
      SELECT item_id,sum(quantity) qty FROM stock_reservations WHERE warehouse_id=$1 AND item_id=$2 AND status='ACTIVE' GROUP BY item_id
    ) SELECT (COALESCE(sum(b.on_hand_qty-b.frozen_qty),0)-COALESCE(max(r.qty),0))::numeric(18,0)::text available
      FROM stock_balances b LEFT JOIN reserved r ON r.item_id=b.item_id WHERE b.warehouse_id=$1 AND b.item_id=$2`, [warehouseId, itemId]);
    const quantity = Math.max(0, 10 - Number(available || 0));
    if (quantity) lines.push({ itemId, batchId, locationId, quantity: String(quantity), direction: Direction.IN });
  }
  if (lines.length) await post({ documentType, warehouseId, notes, lines });
}

async function ensureWarehouses(qr: QueryRunner, adminId: string): Promise<Locations> {
  const definitions = [
    ['RAW-A', '原材料测试一仓', 'RAW'], ['RAW-B', '原材料测试二仓', 'RAW'],
    ['FG-A', '成品测试一仓', 'FG'], ['FG-B', '成品测试二仓', 'FG'], ['DEF', '不良品测试仓', 'DEFECTIVE'],
  ] as const;
  const result: Locations = {};
  for (const [suffix, name, type] of definitions) {
    const code = `${PREFIX}-${suffix}`;
    await qr.query(`INSERT INTO warehouses(warehouse_code,name,display_name,warehouse_type,status) VALUES($1,$2,$2,$3,'ACTIVE')
      ON CONFLICT(warehouse_code) DO UPDATE SET name=EXCLUDED.name,display_name=EXCLUDED.display_name,warehouse_type=EXCLUDED.warehouse_type,status='ACTIVE'`, [code, name, type]);
    const [warehouse] = await qr.query(`SELECT id FROM warehouses WHERE warehouse_code=$1`, [code]);
    const zones: any[] = [];
    for (const [sequence, suffixCode, zoneName] of [[1, 'A', '收发库区'], [2, 'B', '备货库区']] as const) {
      const zoneCode = `${code}-${suffixCode}`;
      await qr.query(`INSERT INTO warehouse_zones(warehouse_id,sequence_no,code,name,actual_location,status) VALUES($1,$2,$3,$4,$4,'ACTIVE')
        ON CONFLICT(warehouse_id,sequence_no) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,status='ACTIVE'`, [warehouse.id, sequence, zoneCode, zoneName]);
      const [zone] = await qr.query(`SELECT id FROM warehouse_zones WHERE warehouse_id=$1 AND sequence_no=$2`, [warehouse.id, sequence]);
      zones.push(zone);
      for (const n of [1, 2]) {
        const locationCode = `${zoneCode}-${String(n).padStart(2, '0')}`;
        await qr.query(`INSERT INTO warehouse_locations(warehouse_id,zone_id,code,name,status,system_default) VALUES($1,$2,$3,$4,'ACTIVE',false)
          ON CONFLICT(warehouse_id,code) DO UPDATE SET zone_id=EXCLUDED.zone_id,name=EXCLUDED.name,status='ACTIVE'`, [warehouse.id, zone.id, locationCode, `${zoneName}${n}号库位`]);
      }
    }
    const locations = await qr.query(`SELECT id,zone_id,code FROM warehouse_locations WHERE warehouse_id=$1 AND code LIKE $2 ORDER BY code`, [warehouse.id, `${code}-%`]);
    const byCode = Object.fromEntries(locations.map((row: any) => [row.code, row]));
    const key = suffix === 'RAW-A' ? 'rawA' : suffix === 'RAW-B' ? 'rawB' : suffix === 'FG-A' ? 'fgA' : suffix === 'FG-B' ? 'fgB' : 'def';
    result[key] = { warehouseId: warehouse.id, zoneA: zones[0].id, zoneB: zones[1].id, a01: byCode[`${code}-A-01`].id, a02: byCode[`${code}-A-02`].id, b01: byCode[`${code}-B-01`].id, b02: byCode[`${code}-B-02`].id };
    await qr.query(`INSERT INTO warehouse_manager(warehouse_id,user_id,created_by) SELECT $1,u.id,$2 FROM users u WHERE u.username='warehouse'
      ON CONFLICT(warehouse_id,user_id) DO NOTHING`, [warehouse.id, adminId]);
  }
  return result;
}

async function ensureLimitedWarehouseManager(qr: QueryRunner, adminId: string, warehouseId: string) {
  await qr.query(`INSERT INTO users(username,name,password_hash,role,role_id,employee_name,position_type,manager_user_id,department_name,can_approve)
    SELECT 'warehouse-limited','受限仓库管理员',u.password_hash,u.role,u.role_id,'受限仓库管理员','WAREHOUSE_MANAGER',$1,'仓储部',false
    FROM users u WHERE u.username='warehouse'
    ON CONFLICT(username) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role,role_id=EXCLUDED.role_id,employee_name=EXCLUDED.employee_name,position_type=EXCLUDED.position_type,manager_user_id=EXCLUDED.manager_user_id,department_name=EXCLUDED.department_name,can_approve=false`, [adminId]);
  await qr.query(`INSERT INTO warehouse_manager(warehouse_id,user_id,created_by)
    SELECT $1,u.id,$2 FROM users u WHERE u.username='warehouse-limited'
    ON CONFLICT(warehouse_id,user_id) DO NOTHING`, [warehouseId, adminId]);
}

async function ensureItems(qr: QueryRunner) {
  const specs = [
    ['TEST-FUNC-M-001', '测试电机', 'MATERIAL', '个', '20'], ['TEST-FUNC-M-002', '测试外壳', 'MATERIAL', '个', '90'],
    ['TEST-FUNC-M-003', '测试紧固件', 'MATERIAL', '个', '120'], ['TEST-FUNC-M-004', '测试树脂', 'MATERIAL', '千克', '10'], ['TEST-FUNC-M-005', '测试低库存物料', 'MATERIAL', '个', '20'],
    ['TEST-FUNC-FG-001', '测试智能终端', 'FINISHED_GOOD', '台', '15'],
  ] as const;
  const categoryIds: Record<string, string> = {};
  for (const type of ['MATERIAL', 'FINISHED_GOOD']) {
    await qr.query(`INSERT INTO item_categories(code,name,item_type,status,sort_order,system_protected) VALUES($1,$1,$2,'ACTIVE',0,false)
      ON CONFLICT(item_type,code) DO UPDATE SET status='ACTIVE'`, [`${PREFIX}-${type}`, type]);
    const [category] = await qr.query(`SELECT id FROM item_categories WHERE code=$1 AND item_type=$2`, [`${PREFIX}-${type}`, type]);
    categoryIds[type] = category.id;
  }
  for (const [code, name, type, unit, minimum] of specs) {
    await qr.query(`INSERT INTO units(code,name,status) VALUES(upper(substr(md5($1),1,12)),$1,'ACTIVE') ON CONFLICT(code) DO UPDATE SET status='ACTIVE'`, [unit]);
    await qr.query(`INSERT INTO items(item_code,name,item_type,unit,unit_id,category_id,minimum_stock,status)
      SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,u.id,$5::uuid,$6::numeric,'ACTIVE' FROM units u WHERE u.name=$4::varchar
      ON CONFLICT(item_code) DO UPDATE SET name=EXCLUDED.name,minimum_stock=EXCLUDED.minimum_stock,status='ACTIVE'`, [code, name, type, unit, categoryIds[type], minimum]);
  }
  const rows = await qr.query(`SELECT id,item_code FROM items WHERE item_code LIKE 'TEST-FUNC-%'`);
  const ids = Object.fromEntries(rows.map((row: any) => [row.item_code, row.id]));
  let [bom] = await qr.query(`SELECT id FROM boms WHERE finished_good_id=$1 AND version='TEST-FUNC-V1' AND deleted_at IS NULL`, [ids['TEST-FUNC-FG-001']]);
  if (!bom) [bom] = await qr.query(`INSERT INTO boms(finished_good_id,version,status,notes) VALUES($1,'TEST-FUNC-V1','ACTIVE',$2) RETURNING id`, [ids['TEST-FUNC-FG-001'], `${PREFIX} 功能测试 BOM`]);
  for (const [material, qty] of [['TEST-FUNC-M-001', '1'], ['TEST-FUNC-M-002', '1'], ['TEST-FUNC-M-003', '4']] as const) {
    await qr.query(`INSERT INTO bom_items(bom_id,material_id,qty_per) VALUES($1,$2,$3) ON CONFLICT(bom_id,material_id) DO UPDATE SET qty_per=EXCLUDED.qty_per`, [bom.id, ids[material], qty]);
  }
  return { motor: ids['TEST-FUNC-M-001'], shell: ids['TEST-FUNC-M-002'], bolt: ids['TEST-FUNC-M-003'], resin: ids['TEST-FUNC-M-004'], lowStock: ids['TEST-FUNC-M-005'], device: ids['TEST-FUNC-FG-001'] };
}

async function ensureBatches(qr: QueryRunner, items: Record<string, string>) {
  const specs = [['motorA', items.motor, 'TEST-FUNC-M1-A'], ['motorB', items.motor, 'TEST-FUNC-M1-B'], ['shellA', items.shell, 'TEST-FUNC-M2-A'], ['boltA', items.bolt, 'TEST-FUNC-M3-A'], ['resinA', items.resin, 'TEST-FUNC-M4-A'], ['lowStockA', items.lowStock, 'TEST-FUNC-M5-A'], ['deviceA', items.device, 'TEST-FUNC-FG1-A'], ['deviceB', items.device, 'TEST-FUNC-FG1-B']] as const;
  const result: Record<string, string> = {};
  for (const [key, itemId, batchNo] of specs) {
    await qr.query(`INSERT INTO inventory_batches(item_id,batch_no,notes,status) VALUES($1,$2,$3,'ACTIVE') ON CONFLICT(item_id,batch_no) DO UPDATE SET status='ACTIVE'`, [itemId, batchNo, `${PREFIX} 批次`]);
    const [batch] = await qr.query(`SELECT id FROM inventory_batches WHERE item_id=$1 AND batch_no=$2`, [itemId, batchNo]);
    result[key] = batch.id;
  }
  return result;
}

async function run() {
  const db = createDataSource();
  await db.initialize();
  try { console.log((await seedFunctionalWarehouse(db)).message); } finally { await db.destroy(); }
}

if (require.main === module) run().catch(error => { console.error(error); process.exit(1); });
