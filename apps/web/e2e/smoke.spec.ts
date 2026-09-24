import { expect, test } from '@playwright/test';

const password = process.env.INITIAL_DEMO_PASSWORD || 'Demo@123456';

async function login(page: any, username: string) {
  const tokens = JSON.parse(process.env.E2E_TOKENS || '{}');
  if (tokens[username]) {
    await page.goto('/');
    await page.evaluate((authToken: string) => localStorage.setItem('inventory_token', authToken), tokens[username]);
    await page.reload();
    await expect(page.getByRole('heading', { name: '库存生产一体化驾驶舱' })).toBeVisible();
    return;
  }
  await page.goto('/');
  await page.getByLabel('账号').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '库存生产一体化驾驶舱' })).toBeVisible();
}

test('三个内置角色可登录并按权限显示菜单', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await page.setViewportSize({ width: 1920, height: 1080 });
  const usernames = ['admin', 'warehouse', 'production'];
  for (const [index, username] of usernames.entries()) {
    await login(page, username);
    await expect(page.getByText('生产任务').first()).toBeVisible();
    await expect(page.getByText('原材料档案').first()).toBeVisible();
    await expect(page.getByText('成品档案').first()).toBeVisible();
    await page.goto('/materials/raw');
    if (username === 'production') await expect(page.getByRole('button', { name: '新增原材料' })).toHaveCount(0);
    else await expect(page.getByRole('button', { name: '新增原材料' })).toBeVisible();
    if (username === 'production') await expect(page.getByText('账号管理')).toHaveCount(0);
    if (index < usernames.length - 1) {
      await page.evaluate(() => localStorage.removeItem('inventory_token'));
      await page.reload();
      await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
    }
  }
});

test('管理员可切换主题并查看构建版本', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'admin');
  await page.getByLabel('切换浅色/深色主题').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByText('V1.8.0', { exact: true })).toBeVisible();
});

test('管理员新增账号时姓名字段可通过参数校验', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'admin');
  await page.goto('/users');
  await page.getByRole('button', { name: '新增账号' }).click();
  const dialog = page.getByRole('dialog');
  const username = `NJHE2E${Date.now()}`;
  await dialog.getByLabel('账号').fill(username);
  await dialog.getByLabel('姓名').fill('参数校验测试');
  const roleSelect = dialog.getByLabel('角色');
  await roleSelect.click();
  await roleSelect.press('ArrowDown');
  await roleSelect.press('Enter');
  await dialog.getByLabel('岗位').click();
  await page.getByText('管理人员', { exact: true }).click();
  await dialog.getByLabel('初始密码').fill('68182170');
  const createResponse = page.waitForResponse(response =>
    response.url().endsWith('/api/users') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /确\s*定/ }).click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  const payload = response.request().postDataJSON();
  expect(payload.employeeName).toBe('参数校验测试');
  expect(payload).not.toHaveProperty('name');
  const created = (await response.json()).data;
  await expect(page.getByText('账号已创建')).toBeVisible();
  await expect(page.getByRole('cell', { name: username })).toBeVisible();
  await page.evaluate(async id => {
    const authToken = localStorage.getItem('inventory_token');
    await fetch(`/api/users/${id}/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
  }, created.id);
});

test('管理员主要路由无白屏、脚本错误和整体横向溢出', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', entry => {
    if (entry.type() === 'error' && !entry.text().startsWith('Warning:')) runtimeErrors.push(entry.text());
  });
  await login(page, 'admin');
  const routes = [
    '/',
    '/virtual-warehouse',
    '/inventory/warehouse-management',
    '/inventory/management?tab=documents',
    '/inventory/management?tab=flows',
    '/inventory/management?tab=reports&reportType=current',
    '/production/tasks',
    '/shortage-todo',
    '/materials/raw',
    '/materials/finished',
    '/materials/new?type=MATERIAL',
    '/material-archive',
    '/items',
    '/boms',
    '/warehouse-archive',
    '/users',
    '/roles',
    '/audit',
    '/system-settings',
    '/about',
  ];
  for (const route of routes) {
    await page.goto(route);
    await expect.poll(() => page.locator('.app-content').evaluate(element => element.textContent?.trim().length ?? 0), {
      message: `${route} 页面内容为空`,
    }).toBeGreaterThan(0);
    const state = await page.locator('.app-content').evaluate(element => ({
      textLength: element.textContent?.trim().length ?? 0,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    expect(state.textLength, `${route} 页面内容为空`).toBeGreaterThan(0);
    expect(state.overflow, `${route} 页面存在整体横向溢出`).toBe(false);
  }
  expect(runtimeErrors).toEqual([]);
});

test('仓库管理工作台支持三级懒加载、兼容路由与桌面宽度适配', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'admin');
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/inventory/warehouse-management');
    await expect(page.getByRole('heading', { name: '仓库管理' })).toBeVisible();
    await expect(page.locator('.warehouse-tree-row.warehouse').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }

  const zone = page.locator('.warehouse-tree-row.zone').first();
  await expect(zone).toBeVisible();
  await zone.locator('.warehouse-tree-toggle').click();
  const location = page.locator('.warehouse-tree-row.location').first();
  await expect(location).toBeVisible();
  await location.click();
  await expect(page.getByText('库位物料库存')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '当前库存' }).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '可用库存' }).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '剩余容量' }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto('/location-capacity?warehouse=RAW&zone=RAW01&location=RAW01-DEFAULT');
  await expect(page).toHaveURL(/\/inventory\/warehouse-management\?warehouse=RAW&zone=RAW01&location=RAW01-DEFAULT/);
  await expect(page.getByRole('heading', { name: '仓库管理' })).toBeVisible();
});

test('手机端使用抽屉导航且页面无整体横向溢出', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await login(page, 'warehouse');
  await page.getByLabel('打开导航').click();
  await expect(page.getByRole('menu').getByText('库存管理', { exact: true })).toBeVisible();
  await page.getByRole('menu').getByText('原材料档案', { exact: true }).click();
  await expect(page.locator('.mobile-record-card').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('一体化驾驶舱在 1920 与 1366 下保持八项指标且无横向溢出', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'admin');
  for (const viewport of [{ width: 1920, height: 1080, sidebar: 220 }, { width: 1366, height: 768, sidebar: 72 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => localStorage.removeItem('inventory_sidebar_collapsed'));
    await page.reload();
    await expect(page.getByRole('heading', { name: '库存生产一体化驾驶舱' })).toBeVisible();
    await expect(page.locator('.cockpit-main-metric')).toHaveCount(4);
    await expect(page.locator('.cockpit-aux-metric')).toHaveCount(4);
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebarWidth: Math.round(document.querySelector('.app-sider')?.getBoundingClientRect().width || 0),
    }));
    expect(layout.overflow).toBe(false);
    expect(layout.sidebarWidth).toBe(viewport.sidebar);
  }
});

test('审核中心和库存管理与标准业务页保持一致左侧留白', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'admin');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/material-categories');
  await expect(page.getByRole('heading', { name: '物料分类' })).toBeVisible();
  const standardLeft = await page.locator('.page').evaluate(element => Math.round(element.getBoundingClientRect().left));
  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: '审核中心' })).toBeVisible();
  const approvalsLeft = await page.locator('.approvals-page').evaluate(element => Math.round(element.getBoundingClientRect().left));
  await page.goto('/inventory/management');
  await expect(page.getByRole('heading', { name: '库存管理' })).toBeVisible();
  const inventoryLeft = await page.locator('.inventory-management-page').evaluate(element => Math.round(element.getBoundingClientRect().left));
  expect(approvalsLeft).toBe(standardLeft);
  expect(inventoryLeft).toBe(standardLeft);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('驾驶舱筛选可由 URL 恢复、刷新保留并规范无效参数', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'admin');
  await page.goto('/?inventoryType=RAW&period=30D&productionStatus=IN_PROGRESS&q=GNSS');
  await expect(page.getByText('库存变化趋势 · 最近 30 天')).toBeVisible();
  await page.reload();
  expect(page.url()).toContain('inventoryType=RAW');
  expect(page.url()).toContain('period=30D');
  expect(page.url()).toContain('productionStatus=IN_PROGRESS');
  expect(page.url()).toContain('q=GNSS');
  await page.goto('/?dateFrom=2026-07-01&dateTo=2026-07-29');
  await expect(page.getByText('库存变化趋势 · 2026-07-01 至 2026-07-29')).toBeVisible();
  await page.reload();
  expect(page.url()).toContain('dateFrom=2026-07-01');
  expect(page.url()).toContain('dateTo=2026-07-29');
  await page.goto('/?inventoryType=bad&period=14D&productionStatus=bad');
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('驾驶舱风险摘要可打开详情抽屉并保持 URL 状态', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'admin');
  const risk = page.locator('.risk-priority-row');
  if (await risk.count()) {
    await risk.first().click();
    await expect(page.getByText('驾驶舱摘要详情')).toBeVisible();
    expect(page.url()).toContain('detailType=risk');
    expect(page.url()).toContain('detailId=');
    await page.getByRole('button', { name: '关闭' }).click();
    expect(page.url()).not.toContain('detailType=');
  }
});
