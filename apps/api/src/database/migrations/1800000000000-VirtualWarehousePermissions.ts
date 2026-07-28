import { MigrationInterface, QueryRunner } from 'typeorm';

export class VirtualWarehousePermissions1800000000000 implements MigrationInterface {
  name = 'VirtualWarehousePermissions1800000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`INSERT INTO permissions(code,name) VALUES
      ('warehouse.virtual.view','查看虚拟仓库'),
      ('warehouse.virtual.operate','从虚拟仓库发起作业')
      ON CONFLICT(code) DO NOTHING`);
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='warehouse.virtual.view'
      WHERE r.code IN ('ADMIN','WAREHOUSE','PRODUCTION')
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `);
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='warehouse.virtual.operate'
      WHERE r.code IN ('ADMIN','WAREHOUSE')
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('warehouse.virtual.view','warehouse.virtual.operate'))`);
  }
}
