# 库存管理系统 MVP

一个基于 React、NestJS 和 PostgreSQL 的模块化单体库存系统，跑通原材料入库、生产任务、领退料、分次报产、独立成品入库、成品出库、库存余额和不可修改流水的完整闭环。

## 核心约束

- 所有库存变化只能调用 `InventoryPostingService`；业务 Controller 和普通 CRUD 服务不能直接修改 `stock_balances`。
- 过账在同一 PostgreSQL 事务中锁定余额、校验负库存、写流水、更新余额和单据状态。
- 已过账单据不能编辑或删除，只能创建反向流水冲销；`stock_transactions` 有数据库触发器禁止更新和删除。
- 过账、冲销、生产领料、生产退料和完工报产必须携带 `Idempotency-Key`。
- 数量使用 `numeric(18,4)`，API 以十进制字符串传输。

## 工程结构

```text
apps/api   NestJS API、TypeORM 迁移、种子数据和 Jest/Supertest 测试
apps/web   React + Vite + Ant Design + ECharts 管理端
docker-compose.yml   PostgreSQL、API 和 Web 一键环境
docker-compose.1panel.yml   1Panel 生产部署专用环境
```

后端模块包括 `auth`、`users`、`items`、`warehouses`、`boms`、`inventory`、`stock-documents`、`production`、`dashboard` 和 `audit`。

## 业务文档

- [完整业务流程图](docs/business-process.md)：按角色说明基础数据、入库、生产领退料、分次报产、成品出库、冲销和追溯关系。
- [全角色图文操作手册](docs/user-guide.md)：覆盖管理员、仓库管理员、生产人员的桌面端和手机端操作。
- [可打印 Word 手册](docs/库存管理系统_业务流程与操作手册.docx)：业务流程图与操作说明合并版。

## Docker 一键启动

```bash
docker compose up --build
```

Windows 未配置 Docker CLI、但 WSL 内有 Docker 时：

```powershell
wsl.exe -e sh -lc "cd '/mnt/c/path/to/inventory-management-mvp' && docker compose -p inventory-mvp up --build"
```

首次启动时 API 会自动执行迁移和幂等种子数据。默认地址：

- Web：[http://localhost:8080](http://localhost:8080)
- API：[http://localhost:3001/api](http://localhost:3001/api)
- Swagger：[http://localhost:3001/api/docs](http://localhost:3001/api/docs)
- PostgreSQL：`localhost:5434`

Web 和 API 的本地调试端口绑定 `127.0.0.1`。Web 前端统一通过同源 `/api` 访问后端，由开发服务器或 Web 容器执行反向代理，因此使用手机访问时不会错误请求手机自身的 `localhost:3001`。

停止服务：

```bash
docker compose down
```

需要同时删除开发数据库卷时才使用 `docker compose down -v`；此操作不可恢复。

## 1Panel 生产部署

公开仓库地址：[HUBO0926/inventory-management-mvp](https://github.com/HUBO0926/inventory-management-mvp)。1Panel 部署只使用 `docker-compose.1panel.yml`，由 1Panel OpenResty 负责域名、反向代理和 HTTPS；不要同时启用 `docker-compose.yml` 的 `public` profile。

1. 在服务器克隆项目并进入目录：

```bash
git clone https://github.com/HUBO0926/inventory-management-mvp.git
cd inventory-management-mvp
cp .env.1panel.example .env
```

2. 在 1Panel 文件管理器或终端编辑 `.env`。必须将 `POSTGRES_PASSWORD`、`JWT_SECRET` 和 `INITIAL_DEMO_PASSWORD` 替换为新的强密码；`.env` 不得提交到 Git。
3. 打开“容器 → Compose”，选择项目目录和 `docker-compose.1panel.yml`，执行构建并启动。此编排不暴露 PostgreSQL 和 API，只将 Web 绑定到 `127.0.0.1:${WEB_PORT:-8080}`。
4. 打开“网站”，新建反向代理网站，将目标设为 `http://127.0.0.1:8080`。随后申请 Let’s Encrypt 证书并开启强制 HTTPS。公网安全组只需开放 80/443。
5. 访问 `https://你的域名/api/health` 检查 API，再使用三个演示账号和 `INITIAL_DEMO_PASSWORD` 登录。首次验证后，管理员应立即在“账号管理”中为三个账号分别设置新密码。

常用运维命令：

```bash
# 状态与健康检查
docker compose -f docker-compose.1panel.yml ps
curl -fsS http://127.0.0.1:8080/api/health

# 日志
docker compose -f docker-compose.1panel.yml logs -f api

# 更新
git pull --ff-only origin main
docker compose -f docker-compose.1panel.yml up -d --build
```

升级前通过 1Panel 备份 `inventory_1panel_postgres` 数据卷。需要回滚时切换到已验证的历史提交，再重新执行 `docker compose -f docker-compose.1panel.yml up -d --build`；数据库迁移向前执行，涉及迁移的版本回滚前应先恢复对应数据库备份。

## 公网 HTTPS 与手机访问

手机端支持完整业务操作。宽度小于 768px 时自动切换为抽屉导航、业务卡片列表、单列详情和移动表单；无需安装 App。

公网部署使用 Caddy 自动申请和续签 HTTPS 证书：

1. 将域名的 A/AAAA 记录解析到部署服务器。
2. 在服务器防火墙和云安全组开放 TCP 80、TCP 443；HTTP/3 可额外开放 UDP 443。
3. 从 `.env.example` 创建 `.env`，至少填写：

```dotenv
PUBLIC_HOST=inventory.example.com
ACME_EMAIL=admin@example.com
```

4. 启动公网入口：

```bash
docker compose --profile public up -d --build
```

访问 `https://你的域名`。Caddy 将 `/api/*` 转发到 API，其余请求转发到 Web；API 和 Web 调试端口仍只监听服务器本机。

证书申请失败时，先确认域名已经解析到当前公网 IP、80/443 未被其他程序占用，并通过 `docker compose logs gateway` 查看 ACME 错误。内网 IP、未备案或受网络策略限制的域名能否签发证书取决于实际 DNS 和公网连通条件。

## 演示账号

| 账号 | 初始密码 | 角色 |
| --- | --- | --- |
| `admin` | `Demo@123456` | 系统管理员 |
| `warehouse` | `Demo@123456` | 仓库管理员 |
| `production` | `Demo@123456` | 生产人员 |

这些是本地开发默认值。1Panel 生产环境统一使用 `.env` 中的 `INITIAL_DEMO_PASSWORD` 首次创建账号；容器重启不会覆盖已修改密码。上线时必须使用新的 JWT 密钥和初始密码，并在首次登录后逐个修改账号密码。

## 本地开发

要求 Node.js 22+、pnpm 11+ 和 PostgreSQL 16+。

```powershell
pnpm install
$env:DATABASE_URL='postgresql://inventory:inventory_dev@localhost:5434/inventory'
pnpm db:migrate
pnpm db:seed
pnpm dev
```

前端开发地址为 `http://localhost:5173`，浏览器请求同源 `/api`，Vite 会将其代理到 `http://localhost:3001`。环境变量模板见 `.env.example`。

迁移和种子可重复执行：

```bash
pnpm db:migrate
pnpm db:seed
```

种子数据包括 RAW、FG 两个仓库，三个演示账号，M-001/M-002/M-003/FG-001 四个物料及 V1 BOM；不伪造库存流水。

## 可视化驾驶舱

登录后的首页为浅色运营驾驶舱，所有数据来自 PostgreSQL 实时聚合：

- 库存 SKU、库存风险、进行中生产任务和今日过账指标。
- RAW/FG 库存健康度、近 7/14/30 天业务单据趋势和生产任务状态图表；趋势单独区分原材料入库、成品入库、出库、生产业务与冲销。
- 库存风险清单、最近库存流水和按角色适配的快捷操作。
- 页面可手动刷新并每 60 秒自动刷新；浏览器页面不可见时暂停自动请求。

驾驶舱接口为 `GET /api/dashboard/cockpit?days=14`，`days` 只允许 `7`、`14`、`30`。旧版 `GET /api/dashboard/summary` 保持兼容。

## 自动化测试

```powershell
pnpm --filter @inventory/api test
$env:DATABASE_URL='postgresql://inventory:inventory_dev@localhost:5434/inventory_test'
pnpm --filter @inventory/api test:e2e
pnpm build
```

E2E 会重建 `DATABASE_URL` 指向数据库的 `public` schema，只能对专用测试数据库执行。测试覆盖：

- 固定库存验收闭环和三类角色权限。
- 相同幂等键重复提交不重复过账。
- 出库超过库存时返回 `INSUFFICIENT_STOCK` 且余额不变。
- 已过账单据冲销和反向流水。
- 独立成品入库草稿、幂等过账、原材料/停用物料拦截、角色权限和冲销恢复。
- 10 个并发出库请求竞争 7 个库存时，恰好 7 个成功、3 个失败，库存不为负。
- 每个仓库和物料的流水累计等于库存余额。
- 驾驶舱 7/14/30 天范围、库存风险、生产状态聚合及三类角色访问。
- 手机断点、角色导航和表格到业务卡片的转换。
- 环境变量初始密码、重复种子不覆盖密码，以及管理员自定义重置密码后旧密码失效。

GitHub Actions 在每次推送和 Pull Request 上使用 Node.js 22、pnpm 和独立 PostgreSQL 16 服务自动执行 lint、单元测试、E2E 和生产构建。

移动界面发布前按 360×800、390×844、430×932、667×375、768×1024 验证，并使用 1366×768 回归桌面端；所有视口均不得出现页面级横向滚动或不可点击操作。

## 固定验收结果

| 步骤 | 验证结果 |
| --- | --- |
| 原材料入库 | RAW：电机 100、外壳 100、螺丝 300 |
| 创建 10 台任务 | BOM 快照需求：10、10、40 |
| 生产领料 | RAW：90、90、260 |
| 退螺丝 1 | RAW 螺丝 261；任务净领螺丝 39 |
| 第一次报产 6 | FG 成品 6；累计完工 6 |
| 第二次报产 4 | FG 成品 10；任务 `COMPLETED` |
| 成品出库 3 | FG 成品 7 |
| 重复幂等键 | 返回首次响应；FG 仍为 7 |
| 尝试出库 8 | HTTP 409；FG 仍为 7 |
| 流水对账 | 所有仓库+物料 `SUM(delta_qty) = on_hand_qty` |

独立成品入库验收：创建 5 台草稿时 FG 不变；过账后 FG 增加 5；重复使用同一幂等键不再次增加；冲销后恢复过账前余额。

## 业务说明

- 生产任务创建时复制启用 BOM；之后修改 BOM 不影响任务快照。
- 发布任务会检查 RAW 库存，缺料时阻止发布并记录缺料标记。
- 累计净领料不能超过需求量的 110%，退料不能超过当前净领料。
- 累计完工不能超过计划数量，达到计划数量后任务自动完成。
- “成品入库”用于不关联生产任务的非完工报产来源，固定进入 FG 且只能选择启用成品；生产任务完工报产仍会自动生成 `PRODUCTION_COMPLETION` 入库，请勿重复登记。
- 手工成品入库使用 `POST /api/stock-documents/finished-inbound` 创建草稿，继续通过通用过账与冲销接口处理，单号以 `FI` 开头。
- 任务存在净领料时不能取消，必须先全部退回。
- 系统管理员拥有全部权限；仓库管理员实际执行领退料和库存单据；生产人员创建、发布任务并报产。

## 常见问题

**端口冲突**：本项目默认使用 Web 8080、API 3001、PostgreSQL 5434，可在 `docker-compose.yml` 中调整宿主机端口。

**发布任务提示缺料**：先由仓库管理员创建原材料入库草稿并提交过账，草稿本身不会改变库存。

**相同幂等键冲突**：同一用户和接口复用了幂等键，但请求内容不同。请为新业务请求生成新 UUID。

**冲销失败**：冲销同样执行负库存和生产累计校验。例如已出库的完工成品不足以反向扣减时，必须先处理后续业务单据。

## MVP 边界

本版本不包含采购、销售订单、质检、审批、批次/序列号、PDA、盘点、调拨、成本核算、工艺路线、微服务或消息队列。
