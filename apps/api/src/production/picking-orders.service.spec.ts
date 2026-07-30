import { PickingOrdersService } from './picking-orders.service';

describe('PickingOrdersService',()=>{
  const service=new PickingOrdersService({} as any,{} as any,{} as any,{} as any,{} as any);
  const shortage={materialId:'m1',itemCode:'M-001',requiredQty:'10.0000',pendingQty:'8.0000'};

  it('limits spare parts to ten percent of BOM demand',()=>{
    expect(()=>((service as any).validateSpare(shortage,'1.0000'))).not.toThrow();
    expect(()=>((service as any).validateSpare(shortage,'1.0001'))).toThrow('10%');
  });

  it('keeps normal and spare allocation separate',()=>{
    const [result]=(service as any).validateMaterials([{
      materialId:'m1',normalQty:'6',spareQty:'1',
      allocations:[{warehouseId:'w1',locationId:'l1',normalQty:'5',spareQty:'1'}],
    }],[shortage]);
    expect(result.normalQty).toBe('6');
    expect(result.spareQty).toBe('1');
    expect(result.allocations).toHaveLength(1);
  });

  it('rejects non-BOM materials and excessive normal issue',()=>{
    expect(()=>((service as any).validateMaterials([{materialId:'other',normalQty:'1',allocations:[]}],[shortage]))).toThrow('BOM');
    expect(()=>((service as any).validateMaterials([{materialId:'m1',normalQty:'9',allocations:[]}],[shortage]))).toThrow('本次待领量');
  });
});
