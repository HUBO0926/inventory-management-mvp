import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveSemiFinished1910000000000 implements MigrationInterface {
  name = 'RemoveSemiFinished1910000000000';

  async up(q: QueryRunner): Promise<void> {
    const [{ count }] = await q.query(`
      SELECT (
        (SELECT count(*) FROM items WHERE item_type='SEMI_FINISHED') +
        (SELECT count(*) FROM boms b JOIN items i ON i.id=b.finished_good_id WHERE i.item_type='SEMI_FINISHED') +
        (SELECT count(*) FROM bom_items bi JOIN items i ON i.id=bi.material_id WHERE i.item_type='SEMI_FINISHED') +
        (SELECT count(*) FROM production_orders po JOIN items i ON i.id=po.finished_good_id WHERE i.item_type='SEMI_FINISHED') +
        (SELECT count(*) FROM stock_document_lines l JOIN items i ON i.id=l.item_id WHERE i.item_type='SEMI_FINISHED')
      )::int count
    `);
    if (Number(count) > 0) throw new Error('检测到半成品历史数据，已停止升级以避免篡改历史；请先完成数据归档后再执行升级。');
    // Earlier category migration creates an empty SEMI_FINISHED category for
    // every database. It is schema residue rather than business history.
    await q.query(`DELETE FROM item_categories WHERE item_type='SEMI_FINISHED'`);
    await q.query(`ALTER TABLE items DROP CONSTRAINT IF EXISTS items_item_type_check`);
    await q.query(`ALTER TABLE items ADD CONSTRAINT items_item_type_check CHECK(item_type IN ('MATERIAL','FINISHED_GOOD'))`);
    await q.query(`ALTER TABLE item_categories DROP CONSTRAINT IF EXISTS item_categories_item_type_check`);
    await q.query(`ALTER TABLE item_categories ADD CONSTRAINT item_categories_item_type_check CHECK(item_type IN ('MATERIAL','FINISHED_GOOD'))`);
  }

  async down(): Promise<void> {
    throw new Error('半成品下线后禁止自动回滚；请恢复升级前数据库备份。');
  }
}
