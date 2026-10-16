import 'reflect-metadata';
import { createDataSource } from './data-source';

/** Online, repeatable preparation for migration 199. Run before the compatibility app rollout. */
async function run() {
  const db = createDataSource();
  await db.initialize();
  const qr = db.createQueryRunner();
  try {
    await qr.connect();
    await qr.startTransaction();
    await qr.query(`SET LOCAL lock_timeout = '2s'`);
    await qr.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS review_status varchar(16) NOT NULL DEFAULT 'PENDING'`);
    await qr.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS review_remark varchar(500)`);
    await qr.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS reviewed_by uuid`);
    await qr.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`);
    await qr.query(`ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS review_changes jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await qr.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_document_lines_review_status_chk') THEN
        ALTER TABLE stock_document_lines ADD CONSTRAINT stock_document_lines_review_status_chk
          CHECK (review_status IN ('PENDING','POSTED','REJECTED')) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_document_lines_reviewed_by_fkey') THEN
        ALTER TABLE stock_document_lines ADD CONSTRAINT stock_document_lines_reviewed_by_fkey
          FOREIGN KEY (reviewed_by) REFERENCES users(id) NOT VALID;
      END IF;
    END $$`);
    await qr.commitTransaction();

    await qr.startTransaction();
    await qr.query(`SET LOCAL lock_timeout = '2s'`);
    const [constraint] = await qr.query(`SELECT convalidated FROM pg_constraint WHERE conname='stock_document_lines_review_status_chk'`);
    if (!constraint) throw new Error('review_status constraint was not created');
    if (!constraint.convalidated) await qr.query(`ALTER TABLE stock_document_lines VALIDATE CONSTRAINT stock_document_lines_review_status_chk`);
    const [reviewerConstraint] = await qr.query(`SELECT convalidated FROM pg_constraint WHERE conname='stock_document_lines_reviewed_by_fkey'`);
    if (!reviewerConstraint) throw new Error('reviewed_by foreign key was not created');
    if (!reviewerConstraint.convalidated) await qr.query(`ALTER TABLE stock_document_lines VALIDATE CONSTRAINT stock_document_lines_reviewed_by_fkey`);
    await qr.commitTransaction();

    const [index] = await db.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='ix_stock_document_lines_review'`);
    if (index && !index.indisvalid) await db.query(`DROP INDEX CONCURRENTLY ix_stock_document_lines_review`);
    if (!index || !index.indisvalid) await db.query(`CREATE INDEX CONCURRENTLY ix_stock_document_lines_review ON stock_document_lines(document_id, review_status)`);

    if (process.argv.includes('--backfill-legacy')) await backfillPostedMaterialLines(db);
  } catch (error) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    throw error;
  } finally {
    await qr.release();
    await db.destroy();
  }
}

async function backfillPostedMaterialLines(db: ReturnType<typeof createDataSource>) {
  let changed: number;
  do {
    const result = await db.query(`WITH batch AS (
      SELECT l.id,d.approved_by,d.posted_by,d.approved_at,d.posted_at
      FROM stock_document_lines l
      JOIN stock_documents d ON d.id=l.document_id
      WHERE d.document_type='MATERIAL_INBOUND' AND d.status='POSTED' AND l.review_status='PENDING'
      ORDER BY l.id
      LIMIT 1000
      FOR UPDATE OF l SKIP LOCKED
    )
    UPDATE stock_document_lines l SET review_status='POSTED',reviewed_by=COALESCE(batch.approved_by,batch.posted_by),
      reviewed_at=COALESCE(batch.approved_at,batch.posted_at,now())
    FROM batch WHERE l.id=batch.id RETURNING l.id`);
    changed = Number(result[1] || 0);
  } while (changed > 0);
}

run().catch(error => { console.error('Online batch-inbound schema preparation failed:', error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1; });
