import { MigrationInterface, QueryRunner } from 'typeorm';

/** A deleted draft keeps its immutable event snapshot, while its live document link is cleared. */
export class ApprovalHistoryDocumentRetention1830000000000 implements MigrationInterface {
  name='ApprovalHistoryDocumentRetention1830000000000';
  async up(q:QueryRunner):Promise<void>{
    await q.query(`CREATE OR REPLACE FUNCTION prevent_approval_record_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP='UPDATE' AND OLD.document_id IS NOT NULL AND NEW.document_id IS NULL
          AND to_jsonb(NEW)-'document_id'=to_jsonb(OLD)-'document_id' THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'approval_records are immutable';
      END; $$ LANGUAGE plpgsql`);
    await q.query(`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_document_id_fkey`);
    await q.query(`ALTER TABLE approval_records ALTER COLUMN document_id DROP NOT NULL`);
    await q.query(`ALTER TABLE approval_records ADD CONSTRAINT approval_records_document_id_fkey FOREIGN KEY(document_id) REFERENCES stock_documents(id) ON DELETE SET NULL`);
  }
  async down():Promise<void>{throw new Error('Approval history retention migration is forward-only.');}
}
