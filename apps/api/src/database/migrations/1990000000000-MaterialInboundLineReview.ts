import { MigrationInterface, QueryRunner } from 'typeorm';

export class MaterialInboundLineReview1990000000000 implements MigrationInterface {
  name = 'MaterialInboundLineReview1990000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS review_status varchar(16) NOT NULL DEFAULT 'PENDING'`);
    await q.query(`DO $$ BEGIN
      ALTER TABLE stock_document_lines ADD CONSTRAINT stock_document_lines_review_status_chk CHECK (review_status IN ('PENDING','POSTED','REJECTED'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS review_remark varchar(500)`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id)`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`);
    await q.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS review_changes jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_stock_document_lines_review ON stock_document_lines(document_id,review_status)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS ix_stock_document_lines_review`);
    await q.query(`ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS review_changes`);
    await q.query(`ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS reviewed_at`);
    await q.query(`ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS reviewed_by`);
    await q.query(`ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS review_remark`);
    await q.query(`ALTER TABLE stock_document_lines DROP CONSTRAINT IF EXISTS stock_document_lines_review_status_chk`);
    await q.query(`ALTER TABLE stock_document_lines DROP COLUMN IF EXISTS review_status`);
  }
}
