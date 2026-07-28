import { MigrationInterface, QueryRunner } from 'typeorm';

export class ItemArchiveImages1760000000000 implements MigrationInterface {
  name = 'ItemArchiveImages1760000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS remark varchar(1000)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS image_url varchar(500)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS thumbnail_url varchar(500)`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS image_size bigint`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS image_width integer`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS image_height integer`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS image_mime_type varchar(100)`);
    await q.query(`ALTER TABLE items ALTER COLUMN spec TYPE varchar(500)`);

    const permissions = [
      ['item.view', '查看物料档案'],
      ['item.manage', '维护物料档案'],
      ['item.identity.manage', '修改物料身份字段'],
      ['item.delete', '删除未引用物料'],
    ];
    for (const [code, name] of permissions) {
      await q.query(
        `INSERT INTO permissions(code,name) VALUES($1,$2)
         ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name`,
        [code, name],
      );
    }

    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT rp.role_id,new_permission.id
      FROM role_permissions rp
      JOIN permissions old_permission ON old_permission.id=rp.permission_id
      JOIN permissions new_permission ON new_permission.code=CASE old_permission.code
        WHEN 'master.view' THEN 'item.view'
        WHEN 'master.manage' THEN 'item.manage'
        WHEN 'master.delete' THEN 'item.delete'
      END
      WHERE old_permission.code IN ('master.view','master.manage','master.delete')
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `);
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT rp.role_id,p.id
      FROM role_permissions rp
      JOIN permissions old_permission ON old_permission.id=rp.permission_id AND old_permission.code='master.manage'
      JOIN permissions p ON p.code='item.identity.manage'
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `);
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r
      JOIN permissions p ON p.code IN ('item.view','item.manage')
      WHERE r.code='WAREHOUSE'
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `);
    await q.query(`
      INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r
      JOIN permissions p ON p.code='item.view'
      WHERE r.code='PRODUCTION'
      ON CONFLICT(role_id,permission_id) DO NOTHING
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM role_permissions
      WHERE permission_id IN (
        SELECT id FROM permissions
        WHERE code IN ('item.view','item.manage','item.identity.manage','item.delete')
      )
    `);
    await q.query(`
      DELETE FROM permissions
      WHERE code IN ('item.view','item.manage','item.identity.manage','item.delete')
    `);
    await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS image_mime_type`);
    await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS image_height`);
    await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS image_width`);
    await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS image_size`);
    await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS thumbnail_url`);
    await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS image_url`);
    await q.query(`ALTER TABLE items DROP COLUMN IF EXISTS remark`);
  }
}
