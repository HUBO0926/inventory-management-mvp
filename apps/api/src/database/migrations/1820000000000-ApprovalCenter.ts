import { MigrationInterface, QueryRunner } from 'typeorm';

/** 审核中心只记录单据状态事件，不复制或改写库存业务数据。 */
export class ApprovalCenter1820000000000 implements MigrationInterface {
  name = 'ApprovalCenter1820000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE approval_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid NOT NULL REFERENCES stock_documents(id) ON DELETE RESTRICT,
      document_no varchar(100) NOT NULL,
      document_type varchar(50) NOT NULL,
      action varchar(32) NOT NULL,
      status_before varchar(30) NOT NULL,
      status_after varchar(30) NOT NULL,
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      actor_username varchar(100), actor_name varchar(150),
      reason_code varchar(50), reason varchar(500),
      idempotency_key varchar(200), request_id varchar(100), ip varchar(80),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      source varchar(20) NOT NULL DEFAULT 'SYSTEM',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX ix_approval_records_document_time ON approval_records(document_id,created_at DESC)`);
    await q.query(`CREATE INDEX ix_approval_records_action_time ON approval_records(action,created_at DESC)`);
    await q.query(`CREATE OR REPLACE FUNCTION prevent_approval_record_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'approval_records are immutable'; END; $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER approval_records_immutable BEFORE UPDATE OR DELETE ON approval_records FOR EACH ROW EXECUTE FUNCTION prevent_approval_record_mutation()`);

    await q.query(`CREATE TABLE role_approval_scopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      document_type varchar(50), warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
      allow_self_approval boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE UNIQUE INDEX ux_role_approval_scope ON role_approval_scopes(role_id,COALESCE(document_type,''),COALESCE(warehouse_id::text,''))`);

    const permissions = ['approval.view-own','approval.view-all','approval.approve','approval.reject','approval.view-history','approval.statistics'];
    for (const code of permissions) await q.query(`INSERT INTO permissions(id,code,name) VALUES(gen_random_uuid(),$1,$1) ON CONFLICT (code) DO NOTHING`, [code]);
    await q.query(`INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
      WHERE (r.code='ADMIN' OR (r.code='WAREHOUSE' AND p.code IN ('approval.view-own','approval.view-all','approval.approve','approval.reject','approval.view-history','approval.statistics')) OR (r.code='PRODUCTION' AND p.code IN ('approval.view-own','approval.view-history','approval.statistics')))
      AND p.code = ANY($1::text[]) ON CONFLICT DO NOTHING`, [permissions]);
    await q.query(`INSERT INTO role_approval_scopes(role_id,allow_self_approval)
      SELECT id,code='ADMIN' FROM roles WHERE code IN ('ADMIN','WAREHOUSE') ON CONFLICT DO NOTHING`);

    await q.query(`INSERT INTO approval_records(document_id,document_no,document_type,action,status_before,status_after,actor_user_id,actor_username,actor_name,payload,source,created_at)
      SELECT d.id,d.document_no,d.document_type,'SUBMITTED','DRAFT','SUBMITTED',d.submitted_by_user_id,d.submitted_by_username,d.submitted_by_name,jsonb_build_object('migration',true),'MIGRATION',d.submitted_at
      FROM stock_documents d WHERE d.submitted_at IS NOT NULL`);
    await q.query(`INSERT INTO approval_records(document_id,document_no,document_type,action,status_before,status_after,actor_user_id,actor_username,actor_name,payload,source,created_at)
      SELECT d.id,d.document_no,d.document_type,'APPROVED','SUBMITTED','POSTED',d.approved_by_user_id,d.approved_by_username,d.approved_by_name,jsonb_build_object('migration',true),'MIGRATION',COALESCE(d.approved_at,d.posted_at)
      FROM stock_documents d WHERE COALESCE(d.approved_at,d.posted_at) IS NOT NULL AND d.status IN ('POSTED','VOIDED')`);
    await q.query(`INSERT INTO approval_records(document_id,document_no,document_type,action,status_before,status_after,actor_user_id,actor_username,actor_name,reason,payload,source,created_at)
      SELECT d.id,d.document_no,d.document_type,'REJECTED','SUBMITTED','REJECTED',d.rejected_by_user_id,d.rejected_by_username,d.rejected_by_name,d.rejection_reason,jsonb_build_object('migration',true),'MIGRATION',d.rejected_at
      FROM stock_documents d WHERE d.rejected_at IS NOT NULL`);
  }
  async down(): Promise<void> { throw new Error('Approval center migration is forward-only; restore a database backup to roll back.'); }
}
