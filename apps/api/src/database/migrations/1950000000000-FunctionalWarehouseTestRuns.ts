import { MigrationInterface, QueryRunner } from 'typeorm';

export class FunctionalWarehouseTestRuns1950000000000 implements MigrationInterface {
  name = 'FunctionalWarehouseTestRuns1950000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS functional_test_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_key varchar(120) NOT NULL UNIQUE,
        status varchar(16) NOT NULL CHECK(status IN ('RUNNING','PASSED','FAILED')),
        report jsonb NOT NULL DEFAULT '{}'::jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        created_by varchar(80) NOT NULL DEFAULT 'functional-test'
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS ix_functional_test_runs_started ON functional_test_runs(started_at DESC)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS functional_test_runs`);
  }
}
