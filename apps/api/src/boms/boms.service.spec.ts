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

  it('查询 BOM 明细时返回单件用料备注', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'bom-1', version: 'M-01', status: 'ACTIVE', finishedGoodId: 'fg-1' }])
      .mockResolvedValueOnce([{ materialId: 'material-1', itemCode: 'M-001', qtyPer: '2', remark: '装配前检验' }]);
    const service = new BomsService({ query } as any, {} as any);

    const result = await service.get('bom-1');
    expect(result.lines[0].remark).toBe('装配前检验');
    expect(query.mock.calls[1][0]).toContain('bi.remark');
  });

  it('复制 BOM 时保留每条组成物料备注', async () => {
    const service = new BomsService({ query: jest.fn() } as any, {} as any);
    jest.spyOn(service, 'get').mockResolvedValue({ finishedGoodId: 'fg-1', version: 'M-01', notes: '主备注', lines: [{ materialId: 'material-1', qtyPer: '2', remark: '装配前检验' }] });
    const save = jest.spyOn(service, 'save').mockResolvedValue({ id: 'bom-copy' });

    await service.copy('bom-1', { version: 'M-02', status: 'INACTIVE' }, 'user-1');
    expect(save).toHaveBeenCalledWith(null, expect.objectContaining({
      lines: [{ materialId: 'material-1', qtyPer: '2', remark: '装配前检验' }],
    }), 'user-1');
  });
});
