import { describe, expect, it } from 'vitest';
import { buildLocationSelectorParams } from './warehouse-location-selector';

describe('buildLocationSelectorParams', () => {
  it('移库目标只排除来源库位，不把来源仓或来源层级作为目标树过滤条件', () => {
    const params = buildLocationSelectorParams('transfer-target', 'item-1', {
      warehouseId: 'source-warehouse', zoneId: 'source-zone', locationId: 'source-location',
    }, 'NORMAL', '目标库');

    expect(params.get('itemId')).toBe('item-1');
    expect(params.get('excludeWarehouseId')).toBeNull();
    expect(params.get('excludeLocationId')).toBe('source-location');
    expect(params.get('warehouseId')).toBeNull();
    expect(params.get('zoneId')).toBeNull();
    expect(params.get('locationId')).toBeNull();
    expect(params.get('filter')).toBe('NORMAL');
    expect(params.get('keyword')).toBe('目标库');
  });

  it('入库页面上下文只用于默认定位，首次查询不限制同类型目标仓', () => {
    const params = buildLocationSelectorParams('inbound', 'item-1', {
      warehouseId: 'warehouse-1', zoneId: 'zone-1', locationId: 'location-1',
    }, 'ALL', '', {});
    expect(params.get('warehouseId')).toBeNull();
    expect(params.get('zoneId')).toBeNull();
    expect(params.get('locationId')).toBeNull();
    expect(params.get('excludeWarehouseId')).toBeNull();
  });

  it('入库单确认首个库位后仅查询已锁定仓库', () => {
    const params = buildLocationSelectorParams('inbound', 'item-1', {}, 'ALL', '', { warehouseId: 'warehouse-1' });
    expect(params.get('warehouseId')).toBe('warehouse-1');
  });
});
