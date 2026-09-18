import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductionBomManagement1890000000000 implements MigrationInterface {
  name = 'ProductionBomManagement1890000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='bom.manage'
      WHERE r.code='PRODUCTION'
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM role_permissions rp USING roles r,permissions p
      WHERE rp.role_id=r.id AND rp.permission_id=p.id
        AND r.code='PRODUCTION' AND p.code='bom.manage'
    `);
  }
}
