import { describe, expect, it } from 'vitest';
import { routes, visibleRouteKeysForRole } from './App';

describe('移动导航权限', () => {
  it('仓库角色包含完整库存作业入口', () => {
    expect(visibleRouteKeysForRole('WAREHOUSE')).toEqual([
      '/',
      '/virtual-warehouse',
      '/approvals',
      '/notifications',
      '/inventory/management',
      '/inventory/warehouse-management',
      '/production/tasks',
      '/materials/raw',
      '/materials/finished',
      '/material-categories',
    ]);
  });

  it('生产角色不暴露库存过账和系统管理入口', () => {
    const routes = visibleRouteKeysForRole('PRODUCTION');
    expect(routes).toContain('/production/tasks');
    expect(routes).toContain('/inventory/management');
    expect(routes).toContain('/material-categories');
    expect(routes).toContain('/approvals');
    expect(routes).not.toContain('/stock-documents');
    expect(routes).not.toContain('/stock-reports');
    expect(routes).not.toContain('/inventory/warehouse-management');
    expect(routes).not.toContain('/users');
  });

  it('BOM 菜单由 bom.view 权限控制，而非管理员角色硬编码', () => {
    const bom = routes.find(route => route.key === '/boms');
    expect(bom?.roles).toEqual([]);
    expect(bom?.permission).toBe('bom.view');
  });
});
