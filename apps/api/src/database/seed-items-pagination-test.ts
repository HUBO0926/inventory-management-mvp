import { createDataSource } from './data-source';

/**
 * 物料下拉分页测试数据：一次性造 200 个 MATERIAL 物料。
 * 编码统一用 TEST-ITEM- 前缀（字母排在数字编码之后），保证它们落在 /items 列表的后段分页，
 * 用来验证新建入库单的物料下拉是否会补齐 100 条之后的页。
 * 清理：pnpm ts-node -r tsconfig-paths/register src/database/cleanup-items-pagination-test.ts
 */
export const ITEM_PAGINATION_TEST_PREFIX = 'TEST-ITEM-';
export const ITEM_PAGINATION_TEST_REMARK = '物料下拉分页测试数据';
const TEST_SIZE = 200;

const nameRoots = ['电池', '连接线', '传感器', '支架', '螺栓', '开关', '继电器', '线束', '电阻', '电容', '外壳', '密封圈', '轴承', '齿轮', '散热片', '连接器', '扎带', '标签', '胶带', '套管'];
const suffixes = ['A型', 'B型', '通用型', '加强款', '标准款', '微型', '加长型', '耐高温型', '防水型', '工业级'];
const specs = ['M3×10', 'M4×16', 'M5×20', 'Φ8×1.2', 'Φ10×1.5', '0.5mm²', '1.0mm²', '2.5mm²', '12V/2A', '24V/5A', 'IP65', 'IP67', '-20~85℃', '长100mm', '长200mm'];
const brands = ['测试品牌甲', '测试品牌乙', '测试品牌丙'];

// 简单可复现的伪随机：用序号做种子，重复执行生成的内容稳定（配合 upsert 不产生脏数据）
function seededRandom(seed: number) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}
const pick = <T,>(list: T[], seed: number) => list[Math.floor(seededRandom(seed) * list.length) % list.length];

async function run() {
  const db = createDataSource();
  await db.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // items.unit_id 是 NOT NULL，单位必须取单位档案里真实存在的行（同时写 unit 文本与 unit_id）
    const unitRows: Array<{ id: string; name: string }> = await runner.query(`SELECT id,name FROM units WHERE status='ACTIVE' ORDER BY created_at`);
    if (!unitRows.length) throw new Error('单位档案（units）中没有启用的单位，请先在系统中维护单位');
    for (let index = 1; index <= TEST_SIZE; index += 1) {
      const seed = index;
      const itemCode = `${ITEM_PAGINATION_TEST_PREFIX}${String(index).padStart(3, '0')}`;
      const name = `${pick(nameRoots, seed)}${pick(suffixes, seed + 3)}-${String(index).padStart(3, '0')}`;
      const unitRow = unitRows[Math.floor(seededRandom(seed + 11) * unitRows.length) % unitRows.length];
      const spec = pick(specs, seed + 23);
      const model = `MODEL-${1000 + index}`;
      const brand = pick(brands, seed + 37);
      const minimumStock = Math.floor(seededRandom(seed + 5) * 50);
      const enableBatch = seededRandom(seed + 7) > 0.8;
      await runner.query(
        `INSERT INTO items(item_code,name,item_type,unit,unit_id,minimum_stock,status,spec,model,brand,enable_batch,remark)
         VALUES($1,$2,'MATERIAL',$3,$4,$5,'ACTIVE',$6,$7,$8,$9,$10)
         ON CONFLICT(item_code) DO UPDATE SET
           name=EXCLUDED.name,unit=EXCLUDED.unit,unit_id=EXCLUDED.unit_id,minimum_stock=EXCLUDED.minimum_stock,
           spec=EXCLUDED.spec,model=EXCLUDED.model,brand=EXCLUDED.brand,
           enable_batch=EXCLUDED.enable_batch,remark=EXCLUDED.remark,status='ACTIVE',deleted_at=NULL,updated_at=now()`,
        [itemCode, name, unitRow.name, unitRow.id, minimumStock, spec, model, brand, enableBatch, ITEM_PAGINATION_TEST_REMARK],
      );
    }
    const [{ count }] = await runner.query(`SELECT count(*)::int count FROM items WHERE item_type='MATERIAL' AND status='ACTIVE' AND deleted_at IS NULL`);
    await runner.commitTransaction();
    console.log(`已写入 ${TEST_SIZE} 个测试物料（${ITEM_PAGINATION_TEST_PREFIX}001 ~ ${ITEM_PAGINATION_TEST_PREFIX}${String(TEST_SIZE).padStart(3, '0')}），当前启用原材料总数：${count}`);
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
