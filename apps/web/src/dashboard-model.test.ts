import { describe, expect, it } from 'vitest';
import { movementDocumentTotal, quickActionsForRole } from './dashboard-model';

describe('驾驶舱模型', () => {
  it('按角色提供正确的快捷入口', () => {
    expect(quickActionsForRole('WAREHOUSE').map(item => item.to)).toEqual(['/inbound', '/finished-inbound', '/outbound', '/inventory']);
    expect(quickActionsForRole('PRODUCTION').map(item => item.to)).toEqual(['/production', '/inventory', '/transactions']);
    expect(quickActionsForRole('ADMIN')).toHaveLength(4);
  });

  it('库存流动只汇总单据数并正确保留零值', () => {
    expect(movementDocumentTotal([
      { inboundDocumentCount: 1, finishedInboundDocumentCount: 2, outboundDocumentCount: 2, productionDocumentCount: 3, reversalDocumentCount: 0 },
      { inboundDocumentCount: 0, finishedInboundDocumentCount: 1, outboundDocumentCount: 0, productionDocumentCount: 1, reversalDocumentCount: 1 },
    ])).toBe(11);
    expect(movementDocumentTotal([])).toBe(0);
  });
});
