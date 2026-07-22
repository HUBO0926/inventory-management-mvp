import { describe, expect, it } from 'vitest';
import { visibleRouteKeysForRole } from './App';

describe('移动导航权限', () => {
  it('仓库角色包含完整库存作业入口', () => {
    expect(visibleRouteKeysForRole('WAREHOUSE')).toEqual(['/', '/inbound', '/finished-inbound', '/outbound', '/inventory', '/transactions', '/production']);
  });

  it('生产角色不暴露库存过账和系统管理入口', () => {
    const routes = visibleRouteKeysForRole('PRODUCTION');
    expect(routes).toContain('/production');
    expect(routes).not.toContain('/finished-inbound');
    expect(routes).not.toContain('/users');
  });
});
