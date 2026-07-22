import { MigrationInterface, QueryRunner } from 'typeorm';

export class DashboardIndexes1720000000000 implements MigrationInterface {
  name = 'DashboardIndexes1720000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS ix_stock_documents_posted_at ON stock_documents(posted_at DESC) WHERE posted_at IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS ix_stock_documents_posted_at`);
  }
}
