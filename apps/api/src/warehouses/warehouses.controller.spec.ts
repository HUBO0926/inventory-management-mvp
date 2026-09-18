import { WarehousesController } from './warehouses.controller';

describe('WarehousesController inventory views', () => {
  it('returns an area material summary from one aggregated query', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'area-1', name: '原材料区' }])
      .mockResolvedValueOnce([{ materialId: 'item-1', materialCode: 'M-01', quantity: '12', locationCount: 2 }]);
    const controller = new WarehousesController({ query } as any, { assertWarehouse: jest.fn() } as any, {} as any);
    const result = await controller.areaMaterialSummary('warehouse-1', 'area-1', { role: 'ADMIN' } as any);
    expect(result).toEqual({ areaId: 'area-1', areaName: '原材料区', materials: [{ materialId: 'item-1', materialCode: 'M-01', quantity: '12', locationCount: 2 }] });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('GROUP BY i.id');
  });

  it('rejects a missing area before requesting its material aggregation', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const controller = new WarehousesController({ query } as any, { assertWarehouse: jest.fn() } as any, {} as any);
    await expect(controller.areaMaterialSummary('warehouse-1', 'missing', { role: 'ADMIN' } as any)).rejects.toThrow('库区不存在');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
