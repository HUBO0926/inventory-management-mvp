import { MigrationInterface, QueryRunner } from 'typeorm';

export class ItemCategoryTypes1770000000000 implements MigrationInterface {
  name = 'ItemCategoryTypes1770000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE item_categories
        ADD COLUMN item_type varchar(30),
        ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
        ADD COLUMN system_protected boolean NOT NULL DEFAULT false;
      ALTER TABLE item_categories DROP CONSTRAINT IF EXISTS item_categories_code_key;

      DO $$
      DECLARE
        category_row record;
        target_type varchar(30);
        retained_type varchar(30);
        target_id uuid;
        has_references boolean;
      BEGIN
        FOR category_row IN
          SELECT id,code,name,status,created_at,updated_at
          FROM item_categories
          ORDER BY created_at,id
        LOOP
          SELECT EXISTS(SELECT 1 FROM items WHERE category_id=category_row.id)
            INTO has_references;

          IF category_row.code='UNCATEGORIZED' THEN
            retained_type := 'MATERIAL';
          ELSE
            SELECT item_type INTO retained_type
            FROM items
            WHERE category_id=category_row.id
            ORDER BY CASE item_type
              WHEN 'MATERIAL' THEN 1
              WHEN 'SEMI_FINISHED' THEN 2
              ELSE 3
            END
            LIMIT 1;
            retained_type := COALESCE(retained_type,'MATERIAL');
          END IF;

          UPDATE item_categories
          SET item_type=retained_type,
              name=CASE WHEN category_row.code='UNCATEGORIZED' THEN '未分类' ELSE name END,
              system_protected=(category_row.code='UNCATEGORIZED')
          WHERE id=category_row.id;

          FOREACH target_type IN ARRAY ARRAY['MATERIAL','SEMI_FINISHED','FINISHED_GOOD']
          LOOP
            CONTINUE WHEN target_type=retained_type;
            CONTINUE WHEN category_row.code<>'UNCATEGORIZED'
              AND has_references
              AND NOT EXISTS(
                SELECT 1 FROM items
                WHERE category_id=category_row.id AND item_type=target_type
              );

            INSERT INTO item_categories(
              code,name,status,created_at,updated_at,item_type,sort_order,system_protected
            )
            VALUES(
              category_row.code,
              CASE WHEN category_row.code='UNCATEGORIZED' THEN '未分类' ELSE category_row.name END,
              category_row.status,category_row.created_at,category_row.updated_at,
              target_type,0,category_row.code='UNCATEGORIZED'
            )
            RETURNING id INTO target_id;

            UPDATE items
            SET category_id=target_id
            WHERE category_id=category_row.id AND item_type=target_type;
          END LOOP;
        END LOOP;
      END $$;

      ALTER TABLE item_categories ALTER COLUMN item_type SET NOT NULL;
      ALTER TABLE item_categories
        ADD CONSTRAINT item_categories_item_type_check
        CHECK(item_type IN ('MATERIAL','SEMI_FINISHED','FINISHED_GOOD'));
      ALTER TABLE item_categories
        ADD CONSTRAINT item_categories_item_type_code_key UNIQUE(item_type,code);
      ALTER TABLE item_categories
        ADD CONSTRAINT item_categories_id_item_type_key UNIQUE(id,item_type);

      ALTER TABLE items
        ADD CONSTRAINT items_category_type_fk
        FOREIGN KEY(category_id,item_type)
        REFERENCES item_categories(id,item_type);

      INSERT INTO permissions(code,name) VALUES
        ('category.view','查看物料分类'),
        ('category.manage','维护物料分类'),
        ('category.delete','删除物料分类')
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name;

      INSERT INTO role_permissions(role_id,permission_id)
      SELECT role_id,permission_id
      FROM (
        SELECT r.id role_id,p_new.id permission_id
        FROM roles r
        JOIN role_permissions rp ON rp.role_id=r.id
        JOIN permissions p_old ON p_old.id=rp.permission_id
        JOIN permissions p_new ON p_new.code=CASE p_old.code
          WHEN 'master.view' THEN 'category.view'
          WHEN 'master.manage' THEN 'category.manage'
          WHEN 'master.delete' THEN 'category.delete'
        END
        WHERE p_old.code IN ('master.view','master.manage','master.delete')
        UNION
        SELECT r.id,p.id
        FROM roles r
        JOIN permissions p ON
          (r.code='ADMIN' AND p.code IN ('category.view','category.manage','category.delete'))
          OR (r.code='WAREHOUSE' AND p.code IN ('category.view','category.manage','category.delete'))
          OR (r.code='PRODUCTION' AND p.code='category.view')
      ) mapped
      ON CONFLICT DO NOTHING;

      CREATE INDEX ix_item_categories_type_status_sort
        ON item_categories(item_type,status,sort_order,code);
    `);
  }

  async down(): Promise<void> {
    throw new Error('物料分类类型隔离迁移包含历史数据拆分，禁止自动回滚；请恢复升级前数据库备份。');
  }
}
