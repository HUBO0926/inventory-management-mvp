import { DocumentType } from '../common/constants';
import { StockDocumentsService } from './stock-documents.service';

describe('StockDocumentsService itemLocationInventory', () => {
  const createService = (query: jest.Mock) => new StockDocumentsService(
    { query } as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { assertWarehouse: jest.fn(), getAccessibleWarehouseIds: jest.fn().mockResolvedValue(['warehouse-1']) } as any,
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
    expect(query.mock.calls[1][1]).toEqual(['warehouse-1', 'FINISHED_GOOD', null, null, null]);
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

  it('成品出库缺少来源仓库时不回退到任意成品仓', async () => {
    const query = jest.fn();
    await expect(createService(query).create(DocumentType.FINISHED_OUTBOUND, { lines: [{ itemId: 'item-1', locationId: 'location-1', quantity: '1' }] }, { id: 'user-1' } as any))
      .rejects.toThrow('请先选择来源库位');
    expect(query).not.toHaveBeenCalled();
  });

  it('移库缺少来源仓库时不回退到任意仓库', async () => {
    const query = jest.fn();
    await expect(createService(query).createMove({ lines: [{ itemId: 'item-1', locationId: 'location-1', targetWarehouseId: 'warehouse-2', targetLocationId: 'location-2', quantity: '1' }] }, { id: 'user-1' } as any))
      .rejects.toThrow('请先选择移出位置');
    expect(query).not.toHaveBeenCalled();
  });

  it('物料优先的来源查询仅返回当前用户仓库内可用的逐库位批次库存', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'item-1', itemCode: 'FG-1', name: '成品', unit: '件', itemType: 'FINISHED_GOOD' }])
      .mockResolvedValueOnce([
        { warehouseId: 'warehouse-1', warehouseCode: 'FG-A', warehouseName: '成品仓', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A区', locationId: 'location-1', locationCode: 'A-01', locationName: 'A-01', batchId: 'batch-1', batchNo: 'B1', onHandQty: '12', frozenQty: '1', reservedQty: '2', availableQty: '9', locked: false },
        { warehouseId: 'warehouse-1', warehouseCode: 'FG-A', warehouseName: '成品仓', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A区', locationId: 'location-1', locationCode: 'A-01', locationName: 'A-01', batchId: 'batch-2', batchNo: 'B2', onHandQty: '3', frozenQty: '0', reservedQty: '0', availableQty: '3', locked: false },
      ]);
    const result = await createService(query).sourceItemDistribution('item-1', { id: 'user-1' } as any);
    expect(result).toMatchObject({ hasInventory: true });
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toMatchObject({ locationId: 'location-1', availableQty: '12', canSource: true });
    expect(result.locations[0].batches).toHaveLength(2);
    expect(query.mock.calls[1][1]).toEqual(['item-1', 'FG', ['warehouse-1'], null, null]);
  });

  it('原材料来源查询使用 RAW 仓型', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'item-1', itemCode: 'RAW-1', name: '原材料', unit: '件', itemType: 'MATERIAL' }])
      .mockResolvedValueOnce([]);
    const result = await createService(query).sourceItemDistribution('item-1', { id: 'user-1' } as any);
    expect(result).toMatchObject({ hasInventory: false, locations: [] });
    expect(query.mock.calls[1][1]).toEqual(['item-1', 'RAW', ['warehouse-1'], null, null]);
  });

  it('盘点候选仅返回当前仓库、库区、库位范围内的正库存批次', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      { warehouseId: 'warehouse-1', zoneId: 'zone-1', locationId: 'location-1', itemId: 'item-1', batchId: 'batch-1', onHandQty: '8' },
    ]);
    const result = await createService(query).stockCheckCandidates({ warehouseId: 'warehouse-1', zoneId: 'zone-1', locationId: 'location-1', itemId: 'item-1' }, { id: 'user-1' } as any);
    expect(result.lines).toHaveLength(1);
    expect(query.mock.calls[0][1]).toEqual(['warehouse-1', 'zone-1', 'location-1', 'item-1']);
  });

  it('目标库位树保留仓库、库区和库位上下文范围', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'item-1', itemCode: 'RAW-1', name: '原材料', unit: '件', itemType: 'MATERIAL' }])
      .mockResolvedValueOnce([{ warehouseId: 'warehouse-1', warehouseCode: 'RAW-A', warehouseName: '原料仓', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A区', zoneStatus: 'ACTIVE', locationId: 'location-1', locationCode: 'A-01', locationName: 'A-01', locationStatus: 'ACTIVE', isArchived: false, onHandQty: '0', pendingInboundQty: '0', capacityQty: null, itemAllowed: null, locked: false }]);
    const result = await createService(query).targetLocationTree({ itemId: 'item-1', warehouseId: 'warehouse-1', zoneId: 'zone-1', locationId: 'location-1' }, { id: 'user-1' } as any);
    expect(result.warehouses[0].zones[0].locations[0].locationId).toBe('location-1');
    expect(query.mock.calls[1][1]).toEqual(['item-1', 'RAW', ['warehouse-1'], 'warehouse-1', 'zone-1', 'location-1', null, null]);
  });

  it('移库目标树仅排除来源库位，保留来源仓内其它库位', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'item-1', itemCode: 'RAW-1', name: '原材料', unit: '件', itemType: 'MATERIAL' }])
      .mockResolvedValueOnce([{ warehouseId: 'warehouse-1', warehouseCode: 'RAW-A', warehouseName: '原料仓', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A区', zoneStatus: 'ACTIVE', locationId: 'location-2', locationCode: 'A-02', locationName: '可选库位', locationStatus: 'ACTIVE', isArchived: false, onHandQty: '0', pendingInboundQty: '0', capacityQty: null, itemAllowed: null, locked: false }]);
    const result = await createService(query).targetLocationTree({ itemId: 'item-1', excludeLocationId: 'location-1' }, { id: 'user-1' } as any);
    expect(result.warehouses[0].zones[0].locations[0].locationId).toBe('location-2');
    expect(query.mock.calls[1][1]).toEqual(['item-1', 'RAW', ['warehouse-1'], null, null, null, null, 'location-1']);
  });

  it('成品入库按实际库位返回库存分布并标记推荐库位', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'item-1', itemCode: 'FG-1', name: '成品', unit: '件', minimumStock: '2', enableBatch: true }])
      .mockResolvedValueOnce([
        { warehouseId: 'warehouse-1', warehouseCode: 'FG-A', warehouseName: '成品仓 A', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A 区', zoneStatus: 'ACTIVE', locationId: 'location-1', locationCode: 'A-01', locationName: 'A-01', locationStatus: 'ACTIVE', isArchived: false, onHandQty: '12', frozenQty: '1', reservedQty: '2', pendingInboundQty: '0', locationOnHandQty: '12', capacityQty: '30', itemAllowed: null, locked: false },
        { warehouseId: 'warehouse-1', warehouseCode: 'FG-A', warehouseName: '成品仓 A', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A 区', zoneStatus: 'ACTIVE', locationId: 'location-2', locationCode: 'A-02', locationName: 'A-02', locationStatus: 'ACTIVE', isArchived: false, onHandQty: '4', frozenQty: '0', reservedQty: '0', pendingInboundQty: '0', locationOnHandQty: '4', capacityQty: '4', itemAllowed: null, locked: false },
      ]);

    const result = await createService(query).finishedInboundDistribution('item-1', { id: 'user-1' } as any);
    expect(result.locations).toHaveLength(2);
    expect(result.locations[0]).toMatchObject({ locationId: 'location-1', availableQty: '9', remainingCapacityQty: '18', canInbound: true, recommended: true });
    expect(result.locations[1]).toMatchObject({ locationId: 'location-2', state: 'FULL', canInbound: false, disabledReason: '已满库' });
  });

  it('成品入库位置树按可操作仓库、关键词和状态筛选', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'item-1', itemCode: 'FG-1', name: '成品', unit: '件', minimumStock: '2', enableBatch: false }])
      .mockResolvedValueOnce([
        { warehouseId: 'warehouse-1', warehouseCode: 'FG-A', warehouseName: '成品仓 A', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A 区', zoneStatus: 'ACTIVE', locationId: 'location-1', locationCode: 'A-01', locationName: '空库位', locationStatus: 'ACTIVE', isArchived: false, onHandQty: '0', frozenQty: '0', reservedQty: '0', pendingInboundQty: '0', locationOnHandQty: '0', capacityQty: null, itemAllowed: null, locked: false },
        { warehouseId: 'warehouse-1', warehouseCode: 'FG-A', warehouseName: '成品仓 A', zoneId: 'zone-1', zoneCode: 'A', zoneName: 'A 区', zoneStatus: 'ACTIVE', locationId: 'location-2', locationCode: 'A-02', locationName: '已锁定', locationStatus: 'ACTIVE', isArchived: false, onHandQty: '3', frozenQty: '0', reservedQty: '0', pendingInboundQty: '0', locationOnHandQty: '3', capacityQty: null, itemAllowed: null, locked: true },
      ]);

    const result = await createService(query).finishedInboundLocationTree({ itemId: 'item-1', filter: 'EMPTY', keyword: 'A-01' }, { id: 'user-1' } as any);
    expect(result.warehouses).toHaveLength(1);
    expect(result.warehouses![0].zones[0].locations).toMatchObject([{ locationId: 'location-1', state: 'EMPTY', canInbound: true }]);
  });
});
