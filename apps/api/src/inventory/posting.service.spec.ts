import { Direction,DocumentType } from '../common/constants';
import { InventoryPostingService,stableHash } from './posting.service';

describe('InventoryPostingService unit',()=>{
  it('creates stable request fingerprints',()=>{expect(stableHash({id:'1',qty:'1.0000'})).toBe(stableHash({id:'1',qty:'1.0000'}));expect(stableHash({qty:'2'})).not.toBe(stableHash({qty:'1'}));});
  it('rejects duplicate material lines before writing a document',async()=>{const service=new InventoryPostingService({} as any,{log:jest.fn()} as any,{} as any,{} as any);const qr={query:jest.fn()} as any;await expect(service.createDocument(qr,{documentType:DocumentType.MATERIAL_INBOUND,warehouseId:'w',lines:[{itemId:'i',quantity:'1',direction:Direction.IN},{itemId:'i',quantity:'2',direction:Direction.IN}]},'u')).rejects.toMatchObject({errorCode:'VALIDATION_ERROR'});expect(qr.query).not.toHaveBeenCalled();});
  it('restricts finished inbound to the FG warehouse and active finished goods',()=>{
    const service=new InventoryPostingService({} as any,{log:jest.fn()} as any,{} as any,{} as any);
    const validate=(doc:any,lines:any[])=>(service as any).validateWarehouseAndItems(doc,lines);
    expect(()=>validate({document_type:DocumentType.FINISHED_INBOUND,warehouse_code:'FG'},[{item_type:'FINISHED_GOOD',item_status:'ACTIVE'}])).not.toThrow();
    expect(()=>validate({document_type:DocumentType.FINISHED_INBOUND,warehouse_type:'RAW'},[{item_type:'FINISHED_GOOD',item_status:'ACTIVE'}])).toThrow('成品仓库');
    expect(()=>validate({document_type:DocumentType.FINISHED_INBOUND,warehouse_code:'FG'},[{item_type:'MATERIAL',item_status:'ACTIVE'}])).toThrow('只能包含成品');
    expect(()=>validate({document_type:DocumentType.FINISHED_INBOUND,warehouse_code:'FG'},[{item_type:'FINISHED_GOOD',item_status:'INACTIVE'}])).toThrow('启用物料');
  });
  it('assigns one flow number to every posted stock delta',async()=>{
    const numbers={stockFlow:jest.fn().mockResolvedValue('LS-YK-20260923-000021')};
    const service=new InventoryPostingService({} as any,{log:jest.fn()} as any,{} as any,numbers as any);
    const qr={query:jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{id:'balance',on_hand_qty:'5'}])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{username:'operator',name:'操作员',department:'仓储'}])
      .mockResolvedValueOnce([])} as any;
    const result=await (service as any).postLine(qr,'document','user',{item_id:'item',item_code:'ITEM',item_name:'物料',quantity:'2'},'warehouse','location',null,Direction.OUT,DocumentType.STOCK_MOVE);
    expect(numbers.stockFlow).toHaveBeenCalledWith(qr,DocumentType.STOCK_MOVE);
    expect(qr.query.mock.calls.at(-1)[0]).toContain('flow_no');
    expect(qr.query.mock.calls.at(-1)[1]).toContain('LS-YK-20260923-000021');
    expect(result.flowNo).toBe('LS-YK-20260923-000021');
  });
});
