export function selectDefaultInventoryWarehouse(warehouses: any[]) {
  return [...warehouses]
    .filter(warehouse => warehouse.status === 'ACTIVE')
    .sort((left, right) => {
      const typeOrder = (value: string) => value === 'RAW' ? 0 : value === 'FG' ? 1 : value === 'DEFECTIVE' ? 2 : 3;
      return typeOrder(left.warehouseType) - typeOrder(right.warehouseType)
        || String(left.warehouseCode || '').localeCompare(String(right.warehouseCode || ''), 'zh-CN');
    })[0];
}
