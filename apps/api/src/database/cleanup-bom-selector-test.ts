import { createDataSource } from './data-source';
import { BOM_SELECTOR_TEST_PREFIX } from './seed-bom-selector-test';

async function run() {
  const db = createDataSource();
  await db.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const [{ count: materialReferences }] = await runner.query(
      `SELECT count(*)::int count FROM bom_items bi JOIN items i ON i.id=bi.material_id
       JOIN boms b ON b.id=bi.bom_id
       WHERE i.item_code LIKE $1 AND b.finished_good_id NOT IN (SELECT id FROM items WHERE item_code LIKE $1)`,
      [`${BOM_SELECTOR_TEST_PREFIX}%`],
    );
    if (materialReferences > 0) {
      throw new Error(`测试原材料已被 ${materialReferences} 张非测试 BOM 引用，未执行清理`);
    }
    await runner.query(
      `DELETE FROM bom_items WHERE bom_id IN (
         SELECT b.id FROM boms b JOIN items i ON i.id=b.finished_good_id WHERE i.item_code LIKE $1
       )`,
      [`${BOM_SELECTOR_TEST_PREFIX}%`],
    );
    await runner.query(
      `DELETE FROM boms WHERE finished_good_id IN (SELECT id FROM items WHERE item_code LIKE $1)`,
      [`${BOM_SELECTOR_TEST_PREFIX}%`],
    );
    await runner.query(`DELETE FROM items WHERE item_code LIKE $1`, [`${BOM_SELECTOR_TEST_PREFIX}%`]);
    await runner.commitTransaction();
    console.log('BOM 下拉测试数据已清理');
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
