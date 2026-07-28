import { describe, expect, it } from 'vitest';
import { selectDefaultInventoryWarehouse } from './inventory-report-model';

describe('current inventory report model', () => {
  it('selects the first active RAW warehouse before FG and defective warehouses', () => {
    expect(selectDefaultInventoryWarehouse([
      { id: 'disabled', warehouseType: 'RAW', warehouseCode: 'AAA', status: 'INACTIVE' },
      { id: 'fg', warehouseType: 'FG', warehouseCode: 'FG', status: 'ACTIVE' },
      { id: 'raw-b', warehouseType: 'RAW', warehouseCode: 'RAW-B', status: 'ACTIVE' },
      { id: 'raw-a', warehouseType: 'RAW', warehouseCode: 'RAW-A', status: 'ACTIVE' },
      { id: 'defective', warehouseType: 'DEFECTIVE', warehouseCode: 'BLP', status: 'ACTIVE' },
    ])?.id).toBe('raw-a');
  });

  it('falls back to the first active non-RAW warehouse and ignores inactive warehouses', () => {
    expect(selectDefaultInventoryWarehouse([
      { id: 'disabled', warehouseType: 'RAW', warehouseCode: 'RAW', status: 'INACTIVE' },
      { id: 'defective', warehouseType: 'DEFECTIVE', warehouseCode: 'BLP', status: 'ACTIVE' },
      { id: 'fg', warehouseType: 'FG', warehouseCode: 'FG', status: 'ACTIVE' },
    ])?.id).toBe('fg');
    expect(selectDefaultInventoryWarehouse([{ id: 'disabled', status: 'INACTIVE' }])).toBeUndefined();
  });
});
