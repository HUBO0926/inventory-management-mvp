import { DocumentType } from './constants';
import { BusinessNumberService, DOCUMENT_NUMBER_PREFIX, STOCK_FLOW_NUMBER_PREFIX } from './business-number.service';

describe('BusinessNumberService', () => {
  const service = new BusinessNumberService();

  function runner(existing: string[] = []) {
    return {
      query: jest.fn()
        .mockResolvedValueOnce([{ stamp: '20260728190754' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(existing.map(number => ({ number }))),
    } as any;
  }

  it('uses the configured Chinese business initials and fixed 14 digit Beijing time', async () => {
    expect(DOCUMENT_NUMBER_PREFIX).toMatchObject({
      MATERIAL_INBOUND: 'YCLRK',
      FINISHED_INBOUND: 'CPRK',
      FINISHED_OUTBOUND: 'CPCK',
      INVENTORY_ADJUSTMENT: 'KCTZ',
      PRODUCTION_ISSUE: 'SCLL',
      PRODUCTION_RETURN: 'SCTL',
      PRODUCTION_COMPLETION: 'WGBP',
      STOCK_MOVE: 'YK',
      STOCK_CHECK: 'KCPD',
      REVERSAL: 'CX',
    });
    await expect(service.stockDocument(runner(), DocumentType.PRODUCTION_ISSUE))
      .resolves.toBe('SCLL-20260728190754');
    await expect(service.productionOrder(runner())).resolves.toBe('SCRW-20260728190754');
  });

  it('adds a minimum two digit sequence for documents created in the same second', async () => {
    await expect(service.stockDocument(
      runner(['SCLL-20260728190754', 'SCLL-20260728190754-01']),
      DocumentType.PRODUCTION_ISSUE,
    )).resolves.toBe('SCLL-20260728190754-02');
  });

  it('continues naturally after sequence 99', async () => {
    await expect(service.stockDocument(
      runner(['SCLL-20260728190754', 'SCLL-20260728190754-99']),
      DocumentType.PRODUCTION_ISSUE,
    )).resolves.toBe('SCLL-20260728190754-100');
  });

  it('allocates globally increasing six digit stock flow numbers with the mapped business type', async () => {
    const flowRunner = {
      query: jest.fn()
        .mockResolvedValueOnce([{ flowDate: '2026-09-23', dateStamp: '20260923' }])
        .mockResolvedValueOnce([{ sequence: '18' }]),
    } as any;
    await expect(service.stockFlow(flowRunner, DocumentType.STOCK_MOVE))
      .resolves.toBe('LS-YK-20260923-000018');
    expect(flowRunner.query.mock.calls[1][0]).toContain('ON CONFLICT(flow_date) DO UPDATE');
    expect(STOCK_FLOW_NUMBER_PREFIX).toMatchObject({
      FINISHED_INBOUND: 'CPRK', PRODUCTION_COMPLETION: 'CPRK',
      MATERIAL_INBOUND: 'YLRK', PRODUCTION_RETURN: 'YLRK',
      FINISHED_OUTBOUND: 'CPCK', PRODUCTION_ISSUE: 'YLCK',
      STOCK_MOVE: 'YK', STOCK_CHECK: 'PD', INVENTORY_ADJUSTMENT: 'TZ',
      DEFECTIVE_RETURN: 'TZ', DEFECTIVE_REPAIR_RESTOCK: 'TZ',
      DEFECTIVE_PRODUCTION_RETURN: 'TZ', REVERSAL: 'TZ',
    });
  });

  it('rejects flow numbers beyond the six digit daily range', async () => {
    const flowRunner = {
      query: jest.fn()
        .mockResolvedValueOnce([{ flowDate: '2026-09-23', dateStamp: '20260923' }])
        .mockResolvedValueOnce([{ sequence: '1000000' }]),
    } as any;
    await expect(service.stockFlow(flowRunner, DocumentType.STOCK_CHECK))
      .rejects.toMatchObject({ errorCode: 'FLOW_SEQUENCE_EXHAUSTED' });
  });
});
