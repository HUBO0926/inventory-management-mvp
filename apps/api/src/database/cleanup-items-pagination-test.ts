import { createDataSource } from './data-source';
import { ITEM_PAGINATION_TEST_PREFIX } from './seed-items-pagination-test';

async function run() {
  const db = createDataSource();
  await db.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const like = `${ITEM_PAGINATION_TEST_PREFIX}%`;
    // 测试物料一旦被单据/库存/BOM/批次引用就不能直接删，避免误删有用数据
    const checks = [
      ['出入库单据明细', `SELECT count(*)::int c FROM stock_document_lines l JOIN items i ON i.id=l.item_id WHERE i.item_code LIKE $1`],
      ['库存余额', `SELECT count(*)::int c FROM stock_balances s JOIN items i ON i.id=s.item_id WHERE i.item_code LIKE $1`],
      ['BOM 明细', `SELECT count(*)::int c FROM bom_items b JOIN items i ON i.id=b.material_id WHERE i.item_code LIKE $1`],
      ['批次', `SELECT count(*)::int c FROM inventory_batches b JOIN items i ON i.id=b.item_id WHERE i.item_code LIKE $1`],
    ] as const;
    for (const [label, sql] of checks) {
      const [{ c }] = await runner.query(sql, [like]);
      if (Number(c) > 0) throw new Error(`测试物料已被${label}引用 ${c} 处，未执行清理（请先删除相关测试单据/数据）`);
    }
    const result = await runner.query(`DELETE FROM items WHERE item_code LIKE $1`, [like]);
    await runner.commitTransaction();
    console.log(`已清理 ${result?.rowCount ?? 0} 个物料下拉分页测试数据`);
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
