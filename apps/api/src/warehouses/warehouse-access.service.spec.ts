import { WarehouseAccessService } from './warehouse-access.service';

describe('WarehouseAccessService', () => {
  it('管理员不受仓库范围限制', async () => {
    const query = jest.fn();
    const service = new WarehouseAccessService({ query } as any);
    await expect(service.assertWarehouse({ id: 'admin', role: 'ADMIN' } as any, 'warehouse-a')).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('仓库管理员只能通过本人绑定的仓库', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new WarehouseAccessService({ query } as any);
    await expect(service.assertWarehouse({ id: 'manager-a', role: 'WAREHOUSE' } as any, 'warehouse-b'))
      .rejects.toThrow('当前账号未绑定该仓库');
  });

  it('跨仓移库必须同时绑定来源仓和目标仓', async () => {
    const query = jest.fn().mockResolvedValue([{ warehouseId: 'warehouse-a' }]);
    const service = new WarehouseAccessService({ query } as any);
    await expect(service.assertWarehouses({ id: 'manager-a', role: 'WAREHOUSE' } as any, ['warehouse-a', 'warehouse-b']))
      .rejects.toThrow('移库操作需要同时具备来源仓和目标仓权限');
  });
});
