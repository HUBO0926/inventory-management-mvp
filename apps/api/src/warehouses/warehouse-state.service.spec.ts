import { DataSource } from 'typeorm';
import { WarehouseStateService } from './warehouse-state.service';
import { WarehouseAccessService } from './warehouse-access.service';

describe('WarehouseStateService workspace activity', () => {
  it('returns the transaction document type and operator snapshot for the virtual workbench', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const access = { assertWarehouse: jest.fn().mockResolvedValue(undefined) } as unknown as WarehouseAccessService;
    const service = new WarehouseStateService({ query } as unknown as DataSource, access);

    await service.workspace({ id: 'user-1' } as any, 'warehouse-1');

    expect(query.mock.calls[1][0]).toContain('d.document_type "documentType"');
    expect(query.mock.calls[1][0]).toContain('t.operator_name');
  });
});
