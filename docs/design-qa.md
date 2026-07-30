# 库存管理系统界面升级 Design QA

## 2026-07-30 趋势自定义时间与可读性优化

- 库存趋势增加自定义日期区间，使用现有 `dateFrom/dateTo` 并写入URL；预设周期会清除自定义区间，清空区间恢复最近7天。
- 自定义日期仅作用于 `inventoryTrendDetails`，不改变实时库存、生产、质量、今日作业和最近单据口径。
- 五类库存业务统一使用平滑折线和原始数据点；Tooltip补充单据数与关联任务数，数量口径继续按单位隔离。
- 库存、风险、生产、质量、作业、趋势和单据模块增加主题色顶边、标题分隔线、清晰边框和阴影。
- 驾驶舱辅助文字、图例、坐标轴、表格次级信息和空状态提升字号及对比度；修改范围限定在驾驶舱。
- 1366×768实测日期控件正常换行，页面无整体横向滚动；最近单据使用明确列宽和表格内部滚动，避免文字挤压。
- 验证：API Jest 15项、Web Vitest 19项、TypeScript/lint、生产构建及Playwright 8项通过；6项按项目条件跳过。

final result: passed

---

## 2026-07-30 驾驶舱数据中心化重构

- 接口：在保持 `/dashboard/integrated-cockpit` 旧字段兼容的前提下，新增原材料/成品库存中心、完整生产状态、按单位质量分析、统一风险中心、今日作业明细、业务趋势明细和最近单据执行信息。
- 口径：库存中心按“仓库＋物料”核算；待审不计库存和质量；质量仅统计已过账的原材料入库/生产完工审核分配，冲销不计；多单位不合计。
- 阈值：支持 `MATERIAL_DEFECT_WARNING_PERCENT`、`MATERIAL_DEFECT_CRITICAL_PERCENT`、`PRODUCTION_DEFECT_WARNING_PERCENT`、`PRODUCTION_DEFECT_CRITICAL_PERCENT`；未配置或无效时中性展示，不生成质量风险。
- 页面：8 项指标改为原材料、成品、任务及两类质量指标；增加双库存中心、统一风险、生产执行、齐套、双质量面板、零作业合并空状态、三口径趋势和固定操作列单据表。
- 响应式：1920×1080 与 1366×768 实测均为 `scrollWidth === clientWidth`；1366 使用折叠导航，页面无整体横向滚动，明细表仅在自身容器内按需横向滚动。
- 运行时：真实数据下原材料 2 种、成品 1 种、任务 4 项、风险待办 3 项；原材料质量按多单位显示，生产不良率 14.3%；控制台无 error/warning。
- 验证：API Jest 15 项、Web Vitest 18 项、TypeScript/lint、生产构建全部通过；Playwright 8 项通过、6 项按项目条件跳过。
- 已知数据缺口：返工、报废、供应商、独立检验时间、计划开始/完成双日期没有可靠现有字段，页面不虚构数据。
- 回滚：恢复本节涉及的 dashboard controller/service/spec、dashboard model/page/style/test 文件即可；无数据库迁移、无数据回滚步骤。

final result: passed

---

## 2026-07-30 驾驶舱信息层级二次重构

### 设计目标与基线

- Source visual truth：改造前本地驾驶舱 1920×1080、1366×768 截图及确认后的信息架构要求。
- Implementation：本地 `http://127.0.0.1:8080/`，真实管理员数据。
- 核心目标：减少同权重指标卡；强化风险待办；将生产状态、任务进度和齐套明细放入执行层；将作业趋势和单据放入下层。
- 数据边界：只使用现有 `/dashboard/integrated-cockpit` 返回字段；环比、负责人、作业数量和驳回分项没有接口数据时显示实时口径或 `—`，不生成模拟值。

### 最终信息架构

- 第一层：标题、关键词、仓库、库存类型、日期、生产任务、刷新、重置和全屏。
- 第二层：4 个主指标（库存总量、可用库存、生产中任务、风险待办）和 4 个紧凑辅助指标。
- 第三层：三类仓库总览与风险优先队列；风险按严重程度排序并提供业务下钻。
- 第四层：生产状态分布、有效任务进度、物料齐套概览和缺料明细。
- 第五层：七类今日库存作业、库存变化趋势和最近单据紧凑表格。

### Visual QA

- 1920×1080：展开导航；4 主指标和 4 辅助指标层级明显；仓库与风险完整可见；生产执行和物料齐套进入首屏。
- 1366×768：折叠导航；筛选工具栏、全部主/辅指标、仓库总览、风险列表完整可见；生产执行模块顶部进入首屏。
- 两种尺寸均满足 `scrollWidth === clientWidth`，无横向滚动、卡片重叠或文字裁切。
- 生产执行列表排除已取消和已关闭任务，不把取消任务表现为生产中。
- 库存数量以 SKU 为主数字，真实数量在单位标签中分别展示，不使用跨单位合计。
- 风险列表真实展示低库存和待审批；无风险时提供解释和库存健康度入口。
- 今日无过账时仍保留七类业务入口，并明确“暂无已生效作业”。
- 最终浏览器控制台无 error/warning。

### Validation

- API Jest：15 项通过。
- Web Vitest：18 项通过。
- TypeScript/lint：通过。
- Production build：通过。
- Playwright：桌面与移动端 8 项通过；6 项按项目条件跳过。
- [P3] Web 主包仍约 2.71 MB，可在后续性能批次进行路由级拆包。

final result: passed

---

## 2026-07-30 库存生产一体化驾驶舱

### 对比基准

- Source visual truth: Penpot「库存管理系统 UIUX 原型」中的 1920×1080 正常稿（`feb36351-9cfe-80ae-8008-66adeb7f2333`）和 1366×768 紧凑稿（`feb36351-9cfe-80ae-8008-66ae38ef67c1`）。
- Implementation: 本地 `http://127.0.0.1:8080/` 浅色管理员视角。
- Normalization: 分别以 1920×1080、1366×768 CSS 视口检查；浏览器内嵌区域扣除滚动条后，以 `scrollWidth <= clientWidth` 作为无横向溢出的验收条件。
- Data: 所有展示值来自新增只读接口 `/dashboard/integrated-cockpit`；实测快照为正常库存 `台 12｜个 11`、可用库存相同、库存 SKU 3、启用库位 49、占用库位 5、使用率 10.2%、低库存 1、不良品 0、生产中 1、缺料 0、待审批 1。

### Full-view comparison evidence

- 1920：220px 展开侧栏、64px 顶栏、筛选栏、8 项 KPI、3 张仓库概览、风险待办、生产执行、物料齐套及今日作业均在首屏形成完整信息层级。
- 1366：72px 折叠侧栏和紧凑卡片生效；8 项 KPI 保持完整，核心库存、生产、风险和待办可见，无卡片重叠、文字裁切或水平滚动。
- 过滤条件由 URL 保存；刷新、前进后退、无效参数规范化和重置均已通过自动化验证。
- 加载使用定高骨架；真实零值显示为 `0`；列表空数据、整页接口异常、局部刷新、无权限和详情抽屉均有独立状态。

### Focused region comparison evidence

- 应用框架：桌面展开/折叠断点、手动偏好持久化、移动抽屉导航、主题切换、审批通知和账号菜单行为正常。
- 库存口径：实际库存仅含已过账余额；可用库存扣除冻结与有效预占；不良品不进入正常可用库存；跨单位按单位分组，不生成伪总量。
- 生产口径：完工进度读取生产任务正常完工累计；任务状态筛选只联动生产执行、齐套和缺料模块。
- 下钻：低库存、待审批、不良品、生产中、仓库、趋势、单据和任务均映射到现有业务路由；摘要详情使用统一抽屉并同步 `detailType/detailId`。
- 权限：聚合接口返回模块能力，前端隐藏无权限数值和入口；管理员、仓库和生产三类角色已完成登录与菜单回归。
- 视觉令牌：55 个基础/语义/尺寸 CSS 令牌已落地，字体、间距、圆角、阴影、导航和状态色与 Penpot 基准一致；深色主题保持可读。

### Validation

- API Jest：5 个测试套件、15 项测试全部通过。
- Web Vitest：8 个测试文件、18 项测试全部通过。
- TypeScript/lint：API 与 Web 均通过。
- Production build：API 与 Web 均通过。
- Playwright：桌面和移动共 8 项执行通过、6 项按项目条件跳过；覆盖 1920/1366、主要路由、筛选恢复、风险抽屉、移动导航和横向溢出。
- 未发现剩余 P0、P1 或 P2 设计差异。
- [P3] Web 生产包单 chunk 约 2.70 MB，后续可按路由拆分 Ant Design 与 ECharts，不影响本批功能与视觉验收。

final result: passed

---

## 历史界面升级记录

## 对比基准

- Source visual truth: 改造前审计截图（临时测试资产，未纳入仓库）。
- Implementation screenshots:
  - [`screenshots/design-qa-dashboard-1320.png`](screenshots/design-qa-dashboard-1320.png)
  - [`screenshots/design-qa-dashboard-1366.png`](screenshots/design-qa-dashboard-1366.png)
  - [`screenshots/design-qa-dashboard-1920.png`](screenshots/design-qa-dashboard-1920.png)
  - [`screenshots/design-qa-inventory-1366.png`](screenshots/design-qa-inventory-1366.png)
  - [`screenshots/design-qa-login-1366.png`](screenshots/design-qa-login-1366.png)
- State: 浅色主题；空库存种子数据；管理员、仓库管理员、生产人员三种角色均已登录验证。
- Source pixels: 1320×720；source CSS viewport: 1320×720；density: 1x。
- Implementation CSS viewports: 1320×720、1366×768、1920×1080；captured content pixels分别为 1305×712、1351×760、1905×1072，差值来自浏览器滚动条和内嵌预览边界；density: 1x。
- Normalization: 使用相同 1320×720 CSS 视口比较首屏内容，忽略浏览器滚动条占用；额外使用 1366×768、1920×1080 检查响应式布局。

## Full-view comparison evidence

- 改造前首页只有四个简单指标和空流水表，信息层级弱且大面积空白。
- 改造后首屏包含角色标题、异常提示、五个语义指标、快捷操作和图表入口；导航按业务分组，库存风险成为首要视觉信号。
- 1366 与 1920 实测 `scrollWidth` 均未超过可用内容宽度，没有水平滚动或持久控件裁切。
- 1920 下五指标保持单行；1366 下首屏仍保留指标和快捷操作，并能看到图表区域入口。

## Focused region comparison evidence

- 导航与页头：图标风格统一，分组标签、当前菜单、角色标签、折叠按钮和账号菜单对齐正常。
- 指标与图表：红/橙/绿语义与库存风险一致；ECharts 图例、坐标和空状态清晰，没有跨单位数量汇总。
- 当前库存：表头、筛选器、空状态及风险状态列在 1366 下完整可见，没有旧版横向溢出。
- 登录页：1366×768 无滚动，品牌说明、账号表单和演示账号提示保持清晰层级。
- 图片与资产：系统不依赖品牌图片；所有可见功能图标均使用同一 Ant Design 图标库，没有自绘 SVG、emoji 或低质量占位图片。

## Required fidelity surfaces

- Fonts and typography: 使用系统中文字体栈；24px 页面标题、16px 区块标题、12–14px 辅助信息形成稳定层级，未发现截断或异常换行。
- Spacing and layout rhythm: 页面 20–24px 边距、18px 区块间距、10px 圆角和轻阴影保持一致；表格、卡片和工具栏节奏稳定。
- Colors and visual tokens: 深蓝导航、浅灰背景、白色内容面与蓝色主色一致；危险、预警、成功色对比清楚。
- Image quality and asset fidelity: 没有需要匹配的图片资产；Canvas 图表在两个桌面分辨率下清晰渲染。
- Copy and content: 页面文案直接描述库存与生产任务，不包含设计提示词或静态伪业务数据。
- Accessibility and interactions: 登录表单有标签，菜单和操作按钮有可访问名称；账号菜单已支持点击打开；三类角色权限菜单和快捷入口均实际验证。

## Comparison history

### Iteration 1

- [P2] 账号菜单默认仅在悬停时打开，点击触发按钮无法显示退出入口，影响键盘和触屏式操作。
- Fix: 为 Ant Design `Dropdown` 明确增加 `trigger={['click']}`。

### Iteration 2

- Post-fix evidence: 点击头像按钮后出现“退出登录”菜单项，并成功完成管理员 → 仓库管理员 → 生产人员的登录切换。
- 角色标题、导航范围与快捷操作均随角色变化；控制台无 error/warning。
- 未发现剩余 P0、P1 或 P2 问题。

## Follow-up polish

- [P3] 当前单页生产包体仍较大，可在后续非 MVP 优化中按路由拆分 Ant Design 与 ECharts 资源。

final result: passed
