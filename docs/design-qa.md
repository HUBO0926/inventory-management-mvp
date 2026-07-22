# 库存管理系统界面升级 Design QA

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
