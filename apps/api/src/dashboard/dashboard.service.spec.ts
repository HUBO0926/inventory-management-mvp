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
});
