import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrganizationApprovalBinding1870000000000 implements MigrationInterface {
  name = 'OrganizationApprovalBinding1870000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS position_type varchar(30);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS department_name varchar(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS can_approve boolean NOT NULL DEFAULT false;
      UPDATE users SET position_type=CASE role WHEN 'ADMIN' THEN 'SYSTEM_ADMIN' WHEN 'WAREHOUSE' THEN 'WAREHOUSE_MANAGER' ELSE 'PRODUCTION' END WHERE position_type IS NULL;
      UPDATE users SET department_name=department WHERE department_name IS NULL;
      UPDATE users SET can_approve=true WHERE role='ADMIN' OR can_approve IS TRUE;
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_position_type_check;
      ALTER TABLE users ADD CONSTRAINT users_position_type_check CHECK(position_type IS NULL OR position_type IN ('PRODUCTION','WAREHOUSE_MANAGER','MANAGER','SYSTEM_ADMIN'));
      CREATE INDEX IF NOT EXISTS ix_users_manager ON users(manager_user_id);
      CREATE INDEX IF NOT EXISTS ix_users_position_status ON users(position_type,status,can_approve);

      CREATE TABLE IF NOT EXISTS warehouse_manager (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE(warehouse_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS ix_warehouse_manager_user ON warehouse_manager(user_id);

      CREATE TABLE IF NOT EXISTS approval_instance (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL UNIQUE REFERENCES stock_documents(id) ON DELETE RESTRICT,
        business_type varchar(50) NOT NULL,
        business_id uuid NOT NULL,
        applicant_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        applicant_name varchar(150) NOT NULL,
        status varchar(30) NOT NULL DEFAULT 'PENDING',
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS approval_task (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        approval_instance_id uuid NOT NULL REFERENCES approval_instance(id) ON DELETE CASCADE,
        approver_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        approver_name varchar(150) NOT NULL,
        status varchar(30) NOT NULL DEFAULT 'PENDING',
        approval_opinion varchar(500),
        approved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(approval_instance_id,approver_user_id)
      );
      CREATE INDEX IF NOT EXISTS ix_approval_task_approver_status ON approval_task(approver_user_id,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_approval_instance_applicant ON approval_instance(applicant_user_id,created_at DESC);

      CREATE TABLE IF NOT EXISTS notification (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        receiver_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        type varchar(50) NOT NULL,
        title varchar(200) NOT NULL,
        content varchar(1000) NOT NULL,
        business_type varchar(50),
        business_id uuid,
        is_read boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS ix_notification_receiver_read ON notification(receiver_user_id,is_read,created_at DESC);

      INSERT INTO permissions(id,code,name) VALUES
        (gen_random_uuid(),'warehouse.view-all','查看全部仓库'),
        (gen_random_uuid(),'approval.transfer','转交审批'),
        (gen_random_uuid(),'approval.reassign','重新分配审批')
        ON CONFLICT(code) DO NOTHING;
      INSERT INTO role_permissions(role_id,permission_id)
        SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
        WHERE r.code='ADMIN' AND p.code IN ('warehouse.view-all','approval.transfer','approval.reassign')
        ON CONFLICT DO NOTHING;

      INSERT INTO approval_instance(document_id,business_type,business_id,applicant_user_id,applicant_name,status,created_at)
        SELECT d.id,d.document_type,d.id,COALESCE(d.submitted_by_user_id,d.created_by),COALESCE(d.submitted_by_name,u.name,u.username),
          CASE WHEN d.status IN ('POSTED','VOIDED') THEN 'APPROVED' WHEN d.status='REJECTED' THEN 'REJECTED' ELSE 'PENDING' END,
          COALESCE(d.submitted_at,d.created_at)
        FROM stock_documents d JOIN users u ON u.id=COALESCE(d.submitted_by_user_id,d.created_by)
        WHERE d.submitted_at IS NOT NULL OR d.status IN ('POSTED','VOIDED','REJECTED') ON CONFLICT(document_id) DO NOTHING;
      INSERT INTO approval_task(approval_instance_id,approver_user_id,approver_name,status,approved_at,created_at)
        SELECT a.id,u.id,u.name,CASE WHEN d.status IN ('POSTED','VOIDED') THEN 'APPROVED' WHEN d.status='REJECTED' THEN 'REJECTED' ELSE 'PENDING' END,
          CASE WHEN d.status IN ('POSTED','VOIDED','REJECTED') THEN COALESCE(d.approved_at,d.rejected_at,d.posted_at) END,a.created_at
        FROM approval_instance a JOIN stock_documents d ON d.id=a.document_id
        JOIN users applicant ON applicant.id=a.applicant_user_id JOIN users u ON u.id=applicant.manager_user_id
        ON CONFLICT(approval_instance_id,approver_user_id) DO NOTHING;
    `);
  }

  async down(): Promise<void> { throw new Error('Organization approval migration is forward-only; restore a database backup to roll back.'); }
}
