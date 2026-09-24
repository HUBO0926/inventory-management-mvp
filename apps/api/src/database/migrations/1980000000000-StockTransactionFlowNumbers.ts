import { MigrationInterface, QueryRunner } from 'typeorm';

export class StockTransactionFlowNumbers1980000000000 implements MigrationInterface {
  name = 'StockTransactionFlowNumbers1980000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS flow_no varchar(32)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_transactions_flow_no ON stock_transactions(flow_no) WHERE flow_no IS NOT NULL`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS stock_transaction_flow_sequences (
        flow_date date PRIMARY KEY,
        last_sequence integer NOT NULL CHECK(last_sequence >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS stock_transaction_flow_sequences`);
    await q.query(`DROP INDEX IF EXISTS ux_stock_transactions_flow_no`);
    await q.query(`ALTER TABLE stock_transactions DROP COLUMN IF EXISTS flow_no`);
  }
}
