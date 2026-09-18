import { MigrationInterface, QueryRunner } from 'typeorm';

export class WarehouseWorkspacePermissions1930000000000 implements MigrationInterface {
  name = 'WarehouseWorkspacePermissions1930000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`INSERT INTO permissions(code,name) VALUES
      ('warehouse.capacity.view','查看库位容量'),
      ('warehouse.capacity.manage','维护库位容量'),
      ('warehouse.layout.edit','维护仓库二维布局')
      ON CONFLICT(code) DO NOTHING`);
    await q.query(`INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN ('warehouse.capacity.view','warehouse.capacity.manage','warehouse.layout.edit')
      WHERE r.code='ADMIN' ON CONFLICT(role_id,permission_id) DO NOTHING`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('warehouse.capacity.view','warehouse.capacity.manage','warehouse.layout.edit'))`);
    await q.query(`DELETE FROM permissions WHERE code IN ('warehouse.capacity.view','warehouse.capacity.manage','warehouse.layout.edit')`);
  }
}
