import { describe, expect, it } from 'vitest';
import { limitRecentRecords, mapCanvasHeight, topMaterialsByUnit } from './virtual-warehouse-model';

describe('虚拟仓库紧凑工作台模型', () => {
  it('按单位排序并最多显示十种物料', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ unit: index < 11 ? '件' : '根', quantity: index + 1 }));
    expect(topMaterialsByUnit(rows, '件')).toHaveLength(10);
    expect(topMaterialsByUnit(rows, '件')[0].quantity).toBe(11);
    expect(topMaterialsByUnit(rows, '根')).toHaveLength(1);
  });

  it('最近记录默认最多八条', () => expect(limitRecentRecords(Array.from({ length: 10 }, (_, index) => index))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));

  it('地图只包裹实际节点边界，展开后保留更大最小画布', () => {
    expect(mapCanvasHeight([{ y: 24, height: 76 }, { y: 228, height: 76 }])).toBe(328);
    expect(mapCanvasHeight([{ y: 24, height: 76 }], true)).toBe(620);
  });
});
