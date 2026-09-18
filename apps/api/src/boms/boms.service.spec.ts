import { BomsService } from './boms.service';

describe('BomsService itemOptions', () => {
  it('只返回启用成品，并支持关键词和第二页', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ count: 121 }])
      .mockResolvedValueOnce([{ id: 'fg-101', itemCode: 'FG-101', name: '第 101 个成品', itemType: 'FINISHED_GOOD', unit: '个' }]);
    const service = new BomsService({ query } as any, {} as any);

    await expect(service.itemOptions({ role: 'output', keyword: '101', page: '2', pageSize: '100' }))
      .resolves.toEqual({
        items: [{ id: 'fg-101', itemCode: 'FG-101', name: '第 101 个成品', itemType: 'FINISHED_GOOD', unit: '个' }],
        total: 121,
        page: 2,
        pageSize: 100,
      });
    expect(query.mock.calls[0][0]).toContain("i.status='ACTIVE'");
    expect(query.mock.calls[0][0]).toContain('i.item_type=$1');
    expect(query.mock.calls[0][1]).toEqual(['FINISHED_GOOD', '%101%']);
    expect(query.mock.calls[1][1]).toEqual(['FINISHED_GOOD', '%101%', 100, 100]);
  });

  it('组成物料候选只查询启用原材料', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ id: 'material-1', itemCode: 'M-001', name: '原材料', itemType: 'MATERIAL' }]);
    const service = new BomsService({ query } as any, {} as any);

    const result = await service.itemOptions({ role: 'component' });
    expect(result.items[0].itemType).toBe('MATERIAL');
    expect(query.mock.calls[0][1]).toEqual(['MATERIAL']);
  });

  it('拒绝未知的候选角色', async () => {
    const service = new BomsService({ query: jest.fn() } as any, {} as any);
    await expect(service.itemOptions({ role: 'unknown' as any })).rejects.toThrow('BOM 候选物料类型无效');
  });
});
