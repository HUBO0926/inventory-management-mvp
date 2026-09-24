import { expect, test } from '@playwright/test';

const password = process.env.INITIAL_DEMO_PASSWORD || 'Demo@123456';

async function login(page: any, username: string) {
  await page.goto('/');
  await page.getByLabel('账号').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '库存生产一体化驾驶舱' })).toBeVisible();
}

test('TEST-FUNC 仓储数据可被仓管搜索、定位并展示容量状态', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'warehouse');
  await page.goto('/inventory/warehouse-management');
  await expect(page.getByRole('heading', { name: '仓库管理' })).toBeVisible();
  const search = page.getByPlaceholder('搜索仓库 / 库区 / 库位 / 物料');
  await search.fill('TEST-FUNC-RAW-A');
  await expect(page.getByText('原材料测试一仓', { exact: false })).toBeVisible();
  await page.getByText('原材料测试一仓', { exact: false }).first().click();
  await expect(page).toHaveURL(/warehouse=TEST-FUNC-RAW-A/);
  await expect(page.getByText('TEST-FUNC-RAW-A', { exact: true })).toBeVisible();

  for (const width of [1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/inventory/warehouse-management?warehouse=TEST-FUNC-RAW-A&zone=TEST-FUNC-RAW-A-B&location=TEST-FUNC-RAW-A-B-02');
    await expect(page.getByText('满库', { exact: true })).toBeVisible();
    await expect(page.getByText('库位物料库存')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test('生产人员不显示仓库管理入口且接口边界由服务端拒绝', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'production');
  await expect(page.getByText('仓库管理', { exact: true })).toHaveCount(0);
  const status = await page.evaluate(async () => {
    const token = localStorage.getItem('inventory_token');
    const response = await fetch('/api/warehouse-management/warehouses', { headers: { Authorization: `Bearer ${token}` } });
    return response.status;
  });
  expect(status).toBe(403);
});

test('仓库、库区、库位和物料上下文均能预填操作弹窗', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'warehouse');
  const open = async (url: string, name: string) => {
    await page.goto(url);
    await page.getByRole('button', { name: '入库' }).first().click();
    const dialog = page.getByRole('dialog', { name: new RegExp(`入库.*${name}`) });
    await expect(dialog).toBeVisible();
    await dialog.locator('.ant-modal-close').click();
    await expect(dialog).toBeHidden();
  };
  await open('/inventory/warehouse-management?warehouse=TEST-FUNC-RAW-A', '原材料测试一仓');
  await open('/inventory/warehouse-management?warehouse=TEST-FUNC-RAW-A&zone=TEST-FUNC-RAW-A-A', '收发库区');
  await open('/inventory/warehouse-management?warehouse=TEST-FUNC-RAW-A&zone=TEST-FUNC-RAW-A-A&location=TEST-FUNC-RAW-A-A-01', '收发库区1号库位');
  await page.goto('/inventory/warehouse-management?warehouse=TEST-FUNC-RAW-A&zone=TEST-FUNC-RAW-A-A&location=TEST-FUNC-RAW-A-A-01');
  await page.getByText('TEST-FUNC-M-001', { exact: false }).first().click();
  await page.getByRole('button', { name: '入库' }).last().click();
  await expect(page.getByRole('dialog', { name: /入库.*收发库区1号库位/ })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '物料' })).toBeDisabled();
});

test('仓库管理与虚拟仓可双向定位', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'warehouse');
  await page.goto('/inventory/warehouse-management?warehouse=TEST-FUNC-RAW-A&zone=TEST-FUNC-RAW-A-A&location=TEST-FUNC-RAW-A-A-01');
  await page.getByRole('button', { name: '在虚拟仓库查看' }).click();
  await expect(page).toHaveURL(/virtual-warehouse\?warehouse=TEST-FUNC-RAW-A.*location=TEST-FUNC-RAW-A-A-01/);
  await expect(page.getByRole('heading', { name: '虚拟仓库' })).toBeVisible();
  await page.getByText('库位视图').click();
  await page.getByRole('button', { name: '查看详细信息' }).click();
  await expect(page).toHaveURL(/inventory\/warehouse-management.*warehouse=TEST-FUNC-RAW-A.*location=TEST-FUNC-RAW-A-A-01/);
  await expect(page.getByText('库位物料库存')).toBeVisible();
});

test('虚拟仓库以紧凑地图展示并继承库位作业上下文', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'warehouse');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/virtual-warehouse?warehouse=TEST-FUNC-RAW-A&zone=TEST-FUNC-RAW-A-A&location=TEST-FUNC-RAW-A-A-01');
  await expect(page.getByRole('heading', { name: '虚拟仓库' })).toBeVisible();
  await expect(page.locator('.virtual-metrics-compact .virtual-metric')).toHaveCount(4);
  await expect(page.locator('.virtual-konva-wrap').first()).toHaveCSS('height', /^(2|3|4|5)\d{2}px$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole('button', { name: '展开地图' }).click();
  await expect(page.getByRole('dialog', { name: /二维仓储地图/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByText('库位视图').click();
  await page.locator('.virtual-actions-panel').getByRole('button', { name: '入库' }).click();
  await expect(page).toHaveURL(/inventory\/warehouse-management.*operation=inbound/);
  await expect(page.getByRole('dialog', { name: /入库/ })).toBeVisible();
});

test('仓管可从库位弹窗提交入库，审批过账后页面刷新库存动态', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await login(page, 'warehouse');
  await page.goto('/inventory/warehouse-management?warehouse=TEST-FUNC-RAW-A&zone=TEST-FUNC-RAW-A-A&location=TEST-FUNC-RAW-A-A-01');
  await page.getByRole('button', { name: '入库' }).first().click();
  const dialog = page.getByRole('dialog', { name: /入库.*收发库区1号库位/ });
  await dialog.getByLabel('物料').click();
  await page.getByText('TEST-FUNC-M-001 测试电机 (个)', { exact: true }).last().click();
  await dialog.getByLabel('数量').fill('1');
  const marker = `TEST-RUN-UI-${Date.now()}`;
  await dialog.getByLabel('备注').fill(marker);
  const created = page.waitForResponse(response => response.url().includes('/stock-documents/material-inbound') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '提交审批' }).click();
  const document = (await (await created).json()).data;
  await expect(page.getByText('单据已创建并提交审批')).toBeVisible();

  const loginResponse = await request.post('/api/auth/login', { data: { username: 'admin', password } });
  expect(loginResponse.ok()).toBe(true);
  const { data: { accessToken } } = await loginResponse.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const detailResponse = await request.get(`/api/stock-documents/${document.id}`, { headers });
  expect(detailResponse.ok()).toBe(true);
  const { data: detail } = await detailResponse.json();
  const receiptAllocations = detail.lines.map((line: any) => ({
    documentLineId: line.id, disposition: 'NORMAL', warehouseId: detail.warehouseId,
    locationId: line.locationId, batchId: line.batchId, quantity: line.quantity,
  }));
  const approval = await request.post(`/api/approvals/${document.id}/approve`, {
    headers: { ...headers, 'Idempotency-Key': `${marker}-approve` }, data: { receiptAllocations },
  });
  expect(approval.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(document.documentNo, { exact: false })).toBeVisible();
});

test('本地桌面基线按层级懒加载且移动视口不出现页面级横向滚动', async ({ page }, testInfo) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/warehouse-management/')) requests.push(request.url()); });
  await login(page, 'warehouse');
  const started = Date.now();
  await page.goto('/inventory/warehouse-management');
  await expect(page.getByRole('heading', { name: '仓库管理' })).toBeVisible();
  const initialMs = Date.now() - started;
  expect(initialMs).toBeLessThan(10_000);
  expect(requests.some(url => /\/warehouses$/.test(new URL(url).pathname))).toBe(true);
  expect(requests.some(url => /\/locations\//.test(new URL(url).pathname))).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '仓库管理' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
