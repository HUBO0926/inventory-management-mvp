import { StockDocumentsService } from './stock-documents.service';

describe('StockDocumentsService itemLocationInventory', () => {
  const createService = (query: jest.Mock) => new StockDocumentsService(
    { query } as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { assertWarehouse: jest.fn() } as any,
  );

  it('出库只返回有可用批次的库位，并扣减冻结和预占数量', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'warehouse-1', warehouseCode: 'FG', name: '成品仓' }])
      .mockResolvedValueOnce([{ id: 'item-1', itemCode: 'FG-1', name: '成品', unit: '个' }])
      .mockResolvedValueOnce([
        { locationId: 'location-1', zoneCode: 'A', locationCode: 'A-01', onHandQty: '10', frozenQty: '1', reservedQty: '2', availableQty: '7', capacityQty: '12' },
        { locationId: 'location-2', zoneCode: 'A', locationCode: 'A-02', onHandQty: '4', frozenQty: '4', reservedQty: '0', availableQty: '0', capacityQty: null },
      ])
      .mockResolvedValueOnce([
        { locationId: 'location-1', batchId: 'batch-1', batchNo: 'B1', onHandQty: '10', frozenQty: '1', reservedQty: '2', availableQty: '7' },
        { locationId: 'location-2', batchId: null, batchNo: null, onHandQty: '4', frozenQty: '4', reservedQty: '0', availableQty: '0' },
      ]);

    const result = await createService(query).itemLocationInventory({ warehouseId: 'warehouse-1', itemId: 'item-1', purpose: 'OUTBOUND' }, { id: 'user-1' } as any);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toMatchObject({ locationId: 'location-1', availableCapacityQty: '2', isFull: false });
    expect(result.locations[0].batches[0]).toMatchObject({ batchId: 'batch-1', availableQty: '7' });
  });

  it('入库保留空库位并标记已满库位', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'warehouse-1' }])
      .mockResolvedValueOnce([{ id: 'item-1' }])
      .mockResolvedValueOnce([
        { locationId: 'full', onHandQty: '5', frozenQty: '0', reservedQty: '0', availableQty: '5', capacityQty: '5' },
        { locationId: 'empty', onHandQty: '0', frozenQty: '0', reservedQty: '0', availableQty: '0', capacityQty: '8' },
      ])
      .mockResolvedValueOnce([]);

    const result = await createService(query).itemLocationInventory({ warehouseId: 'warehouse-1', itemId: 'item-1', purpose: 'INBOUND' }, { id: 'user-1' } as any);
    expect(result.locations).toHaveLength(2);
    expect(result.locations.find((row: any) => row.locationId === 'full')).toMatchObject({ isFull: true, availableCapacityQty: '0' });
    expect(result.locations.find((row: any) => row.locationId === 'empty')).toMatchObject({ isFull: false, availableCapacityQty: '8' });
  });

  it('拒绝未知的库存分布用途', async () => {
    await expect(createService(jest.fn()).itemLocationInventory({ warehouseId: 'warehouse-1', itemId: 'item-1', purpose: 'OTHER' as any }, { id: 'user-1' } as any))
      .rejects.toThrow('库存分布查询用途无效');
  });

  it('按来源仓汇总可用物料候选，并返回可用库位和批次数', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'warehouse-1', warehouseCode: 'FG', name: '成品仓', warehouseType: 'FG' }])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{ itemId: 'item-1', itemCode: 'FG-1', name: '成品', unit: '件', onHandQty: '12', frozenQty: '1', reservedQty: '2', availableQty: '9', locationCount: 2, batchCount: 3 }]);

    const result = await createService(query).sourceItemOptions({ warehouseId: 'warehouse-1', purpose: 'OUTBOUND', page: '1', pageSize: '100' }, { id: 'user-1' } as any);
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 100 });
    expect(result.items[0]).toMatchObject({ itemId: 'item-1', availableQty: '9', locationCount: 2, batchCount: 3 });
    expect(query.mock.calls[1][1]).toEqual(['warehouse-1', 'FINISHED_GOOD', null]);
  });

  it('拒绝从不良品仓发起普通移库候选查询', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'warehouse-1', warehouseType: 'DEFECTIVE' }]);
    await expect(createService(query).sourceItemOptions({ warehouseId: 'warehouse-1', purpose: 'MOVE_SOURCE' }, { id: 'user-1' } as any))
      .rejects.toThrow('普通移库只支持原材料仓或成品仓');
  });

  it('拒绝从非成品仓查询成品出库候选', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'warehouse-1', warehouseType: 'RAW' }]);
    await expect(createService(query).sourceItemOptions({ warehouseId: 'warehouse-1', purpose: 'OUTBOUND' }, { id: 'user-1' } as any))
      .rejects.toThrow('成品出库只能选择成品仓');
  });
});
