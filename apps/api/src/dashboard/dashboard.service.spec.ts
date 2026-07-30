import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  it('组合驾驶舱聚合数据并保留零值', async () => {
    const responses = [
      [{ materialSkuCount: 3, finishedGoodSkuCount: 1, inventoryRiskSkuCount: 2, activeProductionOrderCount: 1, todayPostedDocumentCount: 4 }],
      [{ warehouseCode: 'RAW', healthySkuCount: 2, lowSkuCount: 1, zeroSkuCount: 0 }],
      [{ date: '2026-07-22', inboundDocumentCount: 0, finishedInboundDocumentCount: 1, outboundDocumentCount: 1, productionDocumentCount: 2, reversalDocumentCount: 0 }],
      [{ status: 'DRAFT', count: 0 }],
      [{ itemCode: 'M-003', riskLevel: 'LOW' }],
      [{ id: 'transaction-1', documentNo: 'DOC-001' }],
    ];
    const db = { query: jest.fn().mockImplementation(() => Promise.resolve(responses.shift())) } as any;
    const result = await new DashboardService(db).cockpit(14);

    expect(db.query).toHaveBeenCalledTimes(6);
    expect(db.query.mock.calls[2][1]).toEqual([14]);
    expect(result.kpis.inventoryRiskSkuCount).toBe(2);
    expect(result.movementTrend[0].inboundDocumentCount).toBe(0);
    expect(result.movementTrend[0].finishedInboundDocumentCount).toBe(1);
    expect(result.riskItems[0].riskLevel).toBe('LOW');
  });

  it('summary 保持旧接口字段兼容', async () => {
    const service = new DashboardService({} as any);
    jest.spyOn(service, 'cockpit').mockResolvedValue({
      kpis: { materialSkuCount: 3, finishedGoodSkuCount: 1, inventoryRiskSkuCount: 0, activeProductionOrderCount: 2, todayPostedDocumentCount: 1 },
      inventoryHealth: [], movementTrend: [], productionStatus: [], riskItems: [], recentTransactions: [{ id: '1' }],
    });
    await expect(service.summary()).resolves.toMatchObject({ materialCount: 3, finishedGoodCount: 1, activeProductionCount: 2 });
  });

  it('一体化驾驶舱按单位返回库存并保留权限能力', async () => {
    const responses = [
      [{ id: 'w1', warehouseCode: 'RAW', name: '原材料库', warehouseType: 'RAW' }],
      [{ unit: '台', actualQty: '12', availableQty: '10' }, { unit: '个', actualQty: '11', availableQty: '11' }],
      [{ inventorySkuCount: 3, totalLocations: 48, occupiedLocations: 5, lowStockCount: 1, zeroStockCount: 0, pendingDefectiveCount: 0, inProgressTaskCount: 1, shortageTaskCount: 0, pendingApprovalCount: 1 }],
      [{ warehouseId: 'w1', warehouseCode: 'RAW', warehouseName: '原材料库', warehouseType: 'RAW', unit: '台', quantity: '5', skuCount: 2, occupiedLocationCount: 3, pendingDefectiveCount: 0 }],
      [{ warehouseId: 'w1', itemId: 'i1', itemCode: 'M1', itemName: '主板', unit: '台', onHandQty: '5', minimumStock: '5', riskLevel: 'LOW' }],
      [{ id: 'd1', documentNo: 'DOC-1' }],
      [{ id: 'p1', plannedQty: '2', completedQty: '1' }],
      [{ productionOrderId: 'p1', itemId: 'i1', requiredQty: '5', netIssuedQty: '1', availableQty: '5', shortageQty: '0' }],
      [{ documentType: 'MATERIAL_INBOUND', count: 1 }],
      [{ date: '2026-07-29', inboundSkuCount: 1, outboundSkuCount: 0, changedSkuCount: 1 }],
      [{ id: 'd1', documentNo: 'DOC-1' }],
      [{ warehouseId: 'w1', warehouseCode: 'RAW', warehouseName: '原材料库', warehouseType: 'RAW', itemId: 'i1', itemCode: 'M1', itemName: '主板', unit: '个', currentQty: '5', frozenQty: '0', reservedQty: '0', availableQty: '5', minimumStock: '5', shortageQty: '0', defectivePendingQty: '0' }],
      [{ scope: 'MATERIAL', itemId: 'i1', itemCode: 'M1', itemName: '主板', unit: '个', disposition: 'NORMAL', quantity: '5', defectReason: '未说明原因', date: '2026-07-29' }],
      [{ documentType: 'MATERIAL_INBOUND', status: 'POSTED', unit: '个', documentCount: 1, quantity: '5' }],
      [{ date: '2026-07-29', documentType: 'MATERIAL_INBOUND', unit: '个', quantity: '5', skuCount: 1, documentCount: 1, taskCount: 0 }],
    ];
    const db = { query: jest.fn().mockImplementation(() => Promise.resolve(responses.shift())) } as any;
    const result = await new DashboardService(db).integratedCockpit(
      { inventoryType: 'ALL', period: '7D', productionStatus: 'ALL', dateFrom: '2026-07-01', dateTo: '2026-07-29' },
      { id: 'u1', username: 'admin', employeeName: '管理员', name: '管理员', role: 'ADMIN' },
    );

    expect(db.query).toHaveBeenCalledTimes(15);
    expect(db.query.mock.calls[12][1]).toEqual([null, null, 7]);
    expect(db.query.mock.calls[14][1]).toEqual([null, 'ALL', 7, '2026-07-01', '2026-07-29']);
    expect(result.kpis.inventoryByUnit).toHaveLength(2);
    expect(result.kpis.locationUsageRate).toBe(10.4);
    expect(result.kpis.lowStockCount).toBe(1);
    expect(result.materialReadiness.readinessRate).toBe(100);
    expect(result.capabilities.dashboard).toBe(true);
    expect(result.inventoryCenters.raw.rows).toHaveLength(1);
    expect(result.materialQuality!.byUnit[0].defectRate).toBe(0);
    expect(result.todayOperationDetails[0].postedDocumentCount).toBe(1);
  });

  it('无业务查看权限时不返回受限模块数据', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) } as any;
    const result = await new DashboardService(db).integratedCockpit(
      { inventoryType: 'ALL', period: '7D', productionStatus: 'ALL' },
      { id: 'u1', username: 'guest', employeeName: '访客', name: '访客', role: 'CUSTOM', permissions: [] },
    );
    expect(result.capabilities.dashboard).toBe(false);
    expect(result.kpis.inventoryByUnit).toEqual([]);
    expect(result.productionExecution.tasks).toEqual([]);
  });
});
