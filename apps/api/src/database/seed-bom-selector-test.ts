import { DataSource } from 'typeorm';
import { createDataSource } from './data-source';

export const BOM_SELECTOR_TEST_PREFIX = 'BOM-SELECT-TEST-';
const TEST_VERSION = 'BOM-SELECT-TEST-V1';
const TEST_REMARK = 'BOM 产出物料下拉分页测试数据';
const TEST_SIZE = 120;

const code = (kind: 'A-RAW' | 'Z-FG', index: number) =>
  `${BOM_SELECTOR_TEST_PREFIX}${kind}-${String(index).padStart(3, '0')}`;

async function testUnit(db: DataSource) {
  const [unit] = await db.query(`SELECT id,name FROM units WHERE name='个' AND status='ACTIVE' ORDER BY created_at LIMIT 1`);
  if (!unit) throw new Error('未找到启用的“个”单位，请先维护单位档案');
  return unit;
}

async function upsertItem(
  db: DataSource,
  values: { itemCode: string; name: string; itemType: 'MATERIAL' | 'FINISHED_GOOD'; status?: 'ACTIVE' | 'INACTIVE'; archived?: boolean },
  unitId: string,
) {
  await db.query(
    `INSERT INTO items(item_code,name,item_type,unit,unit_id,category_id,status,remark,deleted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN now() ELSE NULL END)
     ON CONFLICT(item_code) DO UPDATE SET
       name=EXCLUDED.name,item_type=EXCLUDED.item_type,unit=EXCLUDED.unit,unit_id=EXCLUDED.unit_id,
       category_id=EXCLUDED.category_id,status=EXCLUDED.status,remark=EXCLUDED.remark,deleted_at=EXCLUDED.deleted_at,
       updated_at=now()`,
    [values.itemCode, values.name, values.itemType, '个', unitId, null,
      values.status || 'ACTIVE', TEST_REMARK, Boolean(values.archived)],
  );
}

export async function seedBomSelectorTestData(db: DataSource) {
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const unit = await testUnit(runner.manager as unknown as DataSource);
    for (let index = 1; index <= TEST_SIZE; index += 1) {
      await upsertItem(runner.manager as unknown as DataSource, {
        itemCode: code('A-RAW', index), name: `BOM 下拉测试原材料 ${String(index).padStart(3, '0')}`, itemType: 'MATERIAL',
      }, unit.id);
      await upsertItem(runner.manager as unknown as DataSource, {
        itemCode: code('Z-FG', index), name: `BOM 下拉测试成品 ${String(index).padStart(3, '0')}`, itemType: 'FINISHED_GOOD',
      }, unit.id);
    }
    await upsertItem(runner.manager as unknown as DataSource, {
      itemCode: `${BOM_SELECTOR_TEST_PREFIX}Z-FG-INACTIVE`, name: 'BOM 下拉测试停用成品', itemType: 'FINISHED_GOOD', status: 'INACTIVE',
    }, unit.id);
    await upsertItem(runner.manager as unknown as DataSource, {
      itemCode: `${BOM_SELECTOR_TEST_PREFIX}Z-FG-ARCHIVED`, name: 'BOM 下拉测试归档成品', itemType: 'FINISHED_GOOD', status: 'INACTIVE', archived: true,
    }, unit.id);

    const [finishedGood] = await runner.query(`SELECT id FROM items WHERE item_code=$1`, [code('Z-FG', TEST_SIZE)]);
    const [material] = await runner.query(`SELECT id FROM items WHERE item_code=$1`, [code('A-RAW', TEST_SIZE)]);
    let [bom] = await runner.query(
      `SELECT id FROM boms WHERE finished_good_id=$1 AND version=$2 AND deleted_at IS NULL`,
      [finishedGood.id, TEST_VERSION],
    );
    if (!bom) {
      [bom] = await runner.query(
        `INSERT INTO boms(finished_good_id,version,status,notes) VALUES($1,$2,'INACTIVE',$3) RETURNING id`,
        [finishedGood.id, TEST_VERSION, TEST_REMARK],
      );
    } else {
      await runner.query(`UPDATE boms SET status='INACTIVE',notes=$1,updated_at=now() WHERE id=$2`, [TEST_REMARK, bom.id]);
    }
    await runner.query(
      `INSERT INTO bom_items(bom_id,material_id,qty_per) VALUES($1,$2,'1')
       ON CONFLICT(bom_id,material_id) DO UPDATE SET qty_per=EXCLUDED.qty_per`,
      [bom.id, material.id],
    );
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }

  const rows = await db.query(
    `SELECT item_type "itemType",status,count(*)::int count
     FROM items WHERE item_code LIKE $1 GROUP BY item_type,status ORDER BY item_type,status`,
    [`${BOM_SELECTOR_TEST_PREFIX}%`],
  );
  console.log('BOM 下拉测试数据已保留：', rows);
}

async function run() {
  const db = createDataSource();
  await db.initialize();
  await seedBomSelectorTestData(db);
  await db.destroy();
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
