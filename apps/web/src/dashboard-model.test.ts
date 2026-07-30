import { describe, expect, it } from 'vitest';
import {
  dashboardDetailRoute,
  dashboardFilters,
  dashboardQuery,
  dashboardTrendRangeLabel,
  formatUnitQuantities,
  movementDocumentTotal,
  quickActionsForRole,
} from './dashboard-model';

describe('驾驶舱模型', () => {
  it('按角色提供正确的快捷入口', () => {
    expect(quickActionsForRole('WAREHOUSE').map(item => item.to)).toEqual(['/inbound', '/finished-inbound', '/outbound', '/inventory']);
    expect(quickActionsForRole('PRODUCTION').map(item => item.to)).toEqual(['/production', '/inventory', '/transactions']);
    expect(quickActionsForRole('ADMIN')).toHaveLength(4);
  });

  it('库存流动只汇总单据数并正确保留零值', () => {
    expect(movementDocumentTotal([
      { inboundDocumentCount: 1, finishedInboundDocumentCount: 2, outboundDocumentCount: 2, productionDocumentCount: 3, reversalDocumentCount: 0 },
      { inboundDocumentCount: 0, finishedInboundDocumentCount: 1, outboundDocumentCount: 0, productionDocumentCount: 1, reversalDocumentCount: 1 },
    ])).toBe(11);
    expect(movementDocumentTotal([])).toBe(0);
  });

  it('驾驶舱筛选从 URL 恢复并规范无效参数', () => {
    expect(dashboardFilters(new URLSearchParams('inventoryType=RAW&period=30D&productionStatus=IN_PROGRESS&warehouseId=w1&q=GNSS'))).toEqual({
      inventoryType: 'RAW',
      period: '30D',
      productionStatus: 'IN_PROGRESS',
      warehouseId: 'w1',
      keyword: 'GNSS',
      inventoryStatus: 'ALL',
      categoryId: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      rawPage: 1,
      finishedPage: 1,
    });
    expect(dashboardFilters(new URLSearchParams('inventoryType=bad&period=14D&productionStatus=bad'))).toEqual({
      inventoryType: 'ALL',
      period: '7D',
      productionStatus: 'ALL',
      warehouseId: undefined,
      keyword: undefined,
      inventoryStatus: 'ALL',
      categoryId: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      rawPage: 1,
      finishedPage: 1,
    });
  });

  it('默认筛选不制造冗余 URL，单位数量不跨单位相加', () => {
    const defaults = { inventoryType: 'ALL', inventoryStatus: 'ALL', period: '7D', productionStatus: 'ALL', rawPage: 1, finishedPage: 1 } as const;
    expect(dashboardQuery(defaults).toString()).toBe('');
    expect(dashboardQuery({ ...defaults, keyword: ' GNSS ' }).toString()).toBe('q=GNSS');
    expect(formatUnitQuantities([{ unit: '台', quantity: '12' }, { unit: '个', quantity: '11' }])).toBe('台 12 ｜ 个 11');
  });

  it('自定义趋势日期成对保存并优先显示真实范围', () => {
    const filters = dashboardFilters(new URLSearchParams('period=30D&dateFrom=2026-07-01&dateTo=2026-07-29'));
    expect(filters.dateFrom).toBe('2026-07-01');
    expect(filters.dateTo).toBe('2026-07-29');
    expect(dashboardTrendRangeLabel(filters)).toBe('2026-07-01 至 2026-07-29');
    expect(dashboardQuery(filters).toString()).toContain('dateFrom=2026-07-01');
    expect(dashboardFilters(new URLSearchParams('dateFrom=2026-07-30&dateTo=2026-07-01'))).toMatchObject({
      dateFrom: undefined,
      dateTo: undefined,
    });
  });

  it('详情下钻使用现有业务路由', () => {
    expect(dashboardDetailRoute('warehouse', 'w1')).toBe('/warehouse-virtual?warehouseId=w1');
    expect(dashboardDetailRoute('task', 'p1')).toBe('/production/tasks/p1');
    expect(dashboardDetailRoute('document', 'd1')).toContain('documentId=d1');
    expect(dashboardDetailRoute('risk', 'i1', { warehouseId: 'w1' })).toContain('reportType=low-stock');
  });
});
