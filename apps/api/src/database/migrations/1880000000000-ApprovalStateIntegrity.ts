import { MigrationInterface, QueryRunner } from 'typeorm';

export class ApprovalStateIntegrity1880000000000 implements MigrationInterface {
  name = 'ApprovalStateIntegrity1880000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE approval_instance a SET status='ABNORMAL',completed_at=now()
      FROM stock_documents d
      WHERE a.document_id=d.id AND a.status='PENDING'
        AND NOT EXISTS (
          SELECT 1 FROM approval_task t JOIN users u ON u.id=t.approver_user_id
          WHERE t.approval_instance_id=a.id AND t.status='PENDING' AND u.status='ACTIVE' AND u.can_approve=true
        );
      ALTER TABLE approval_instance DROP CONSTRAINT IF EXISTS approval_instance_status_check;
      ALTER TABLE approval_instance ADD CONSTRAINT approval_instance_status_check
        CHECK(status IN ('PENDING','APPROVED','REJECTED','RETURNED','REVOKED','TRANSFERRED','ABNORMAL'));
      ALTER TABLE approval_task DROP CONSTRAINT IF EXISTS approval_task_status_check;
      ALTER TABLE approval_task ADD CONSTRAINT approval_task_status_check
        CHECK(status IN ('PENDING','APPROVED','REJECTED','RETURNED','REVOKED','TRANSFERRED','ABNORMAL'));
      CREATE INDEX IF NOT EXISTS ix_approval_instance_status_created ON approval_instance(status,created_at DESC);
    `);
  }

  async down(): Promise<void> { throw new Error('Approval state integrity migration is forward-only'); }
}
