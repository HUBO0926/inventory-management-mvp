import Decimal from 'decimal.js';
import { WarehouseManagementService } from './warehouse-management.service';
import { StockDocumentsService } from '../stock-documents/stock-documents.service';

describe('WarehouseManagementService', () => {
  const db:any={query:jest.fn()};
  const access:any={getAccessibleWarehouseIds:jest.fn(),assertWarehouse:jest.fn()};
  const service=new WarehouseManagementService(db,access);
  const stockDocuments=new StockDocumentsService(db,{} as any,{} as any,{} as any,{} as any,{} as any,access,service);

  beforeEach(()=>jest.clearAllMocks());

  it('keeps unlimited locations last and uses the smallest complete finite target',()=>{
    const rows=(stockDocuments as any).allocateTargets([
      {locationId:'unlimited',hasItem:false,remainingQty:null,onHandQty:'0',capacityQty:null},
      {locationId:'large',hasItem:false,remainingQty:'20',onHandQty:'0',capacityQty:'20'},
      {locationId:'best',hasItem:false,remainingQty:'9',onHandQty:'1',capacityQty:'10'},
    ],'item',new Decimal(8));
    expect(rows).toEqual([{itemId:'item',quantity:'8',locationId:'best',targetBeforeQty:'1',capacityQty:'10'}]);
  });

  it('rejects an effective spatial operation lock before posting',async()=>{
    const qr:any={query:jest.fn().mockResolvedValue([{code:'A-01',reason:'盘点封库'}])};
    await expect(service.assertOperationAllowed(qr,['location'])).rejects.toMatchObject({message:'A-01 当前禁止库存作业：盘点封库'});
  });

  it('defaults to allowed when no location item rule exists',async()=>{
    const qr:any={query:jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([])};
    await expect(service.assertOperationAllowed(qr,['location'],[{locationId:'location',itemId:'item'}])).resolves.toBeUndefined();
  });

  it('orders recent activity by timestamp instead of locale-formatted date text', async () => {
    (service as any).scope = jest.fn().mockResolvedValue({ warehouseId: 'warehouse', zoneId: 'zone', locationId: 'location' });
    db.query.mockResolvedValue([
      { documentId: 'old', documentType: 'MATERIAL_INBOUND', createdAt: new Date('2026-09-15T08:00:00Z'), deltaQty: '1' },
      { documentId: 'new', documentType: 'MATERIAL_INBOUND', createdAt: new Date('2026-09-17T08:00:00Z'), deltaQty: '1' },
    ]);
    const rows = await service.activity({} as any, { contextType: 'location', contextId: 'location', pageSize: 12 });
    expect(rows.map((row: any) => row.documentId)).toEqual(['new', 'old']);
  });
});
