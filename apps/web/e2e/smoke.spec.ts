import { expect, test } from '@playwright/test';

const password = process.env.INITIAL_DEMO_PASSWORD || 'Demo@123456';

async function login(page: any, username: string) {
  const tokens = JSON.parse(process.env.E2E_TOKENS || '{}');
  if (tokens[username]) {
    await page.goto('/');
    await page.evaluate((authToken: string) => localStorage.setItem('inventory_token', authToken), tokens[username]);
    await page.reload();
    await expect(page.getByText('库存驾驶舱').first()).toBeVisible();
    return;
  }
  await page.goto('/');
  await page.getByLabel('账号').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByText('库存驾驶舱').first()).toBeVisible();
}

test('三个内置角色可登录并按权限显示菜单', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
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
  await expect(page.getByText('V1.2.0', { exact: true })).toBeVisible();
});

test('管理员主要路由无白屏、脚本错误和整体横向溢出', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', entry => {
    if (entry.type() === 'error') runtimeErrors.push(entry.text());
  });
  await login(page, 'admin');
  const routes = [
    '/',
    '/warehouse-virtual',
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
    const state = await page.locator('.app-content').evaluate(element => ({
      textLength: element.textContent?.trim().length ?? 0,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    expect(state.textLength, `${route} 页面内容为空`).toBeGreaterThan(0);
    expect(state.overflow, `${route} 页面存在整体横向溢出`).toBe(false);
  }
  expect(runtimeErrors).toEqual([]);
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
