# 库存审核与不良品处理升级说明

## 上线前

1. 备份 PostgreSQL 数据库，并保留可验证的恢复点。
2. 在备份副本执行 `pnpm db:migrate`。
3. 迁移会将库存与生产业务数量四舍五入为整数，重建库存流水的 `balance_before / balance_after`，并重新计算余额。
4. 如出现负库存、入库分配不一致、生产累计超过计划或余额与流水不一致，迁移会回滚。必须先修复数据，不得跳过校验。
5. 执行 `pnpm --filter @inventory/api inventory:reconcile`，确认输出 `consistent: true`。

## 正式升级

1. 安排停写窗口，确认没有正在提交或审核的库存单据。
2. 再次备份数据库。
3. 部署同一版本的 API 与 Web，执行迁移和幂等种子；种子会补建默认不良品仓库、主库区和默认库位。
4. 验证 ADMIN、WAREHOUSE 角色拥有 `approval.defective.view` 和 `approval.defective.process`；旧 `stock.approve`、`stock.reject`、`stock.direct_post` 不再授予角色。
5. 逐项冒烟：新建并提交单据、审核中心分配、打印、不良品处理、库存流水和生产累计。

## 验收命令

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm test:upgrade
pnpm test:playwright
```

## 回滚

该迁移包含整数化流水重建和不可修改的不良品处理记录，属于前向迁移。需要回滚时停止写入，恢复升级前数据库备份，并部署升级前应用版本；不要尝试手工执行降级 SQL。
