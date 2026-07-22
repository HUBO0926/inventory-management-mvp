import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { createDataSource } from '../src/database/data-source';
import { seedDatabase } from '../src/database/seed';

describe('库存管理固定验收场景',()=>{
  let app:INestApplication,db:DataSource;let admin='',warehouse='',production='';const ids:any={};
  const auth=(token:string)=>({Authorization:`Bearer ${token}`});
  const login=async(username:string)=>{const r=await request(app.getHttpServer()).post('/api/auth/login').send({username,password:'Demo@123456'}).expect(201);return r.body.data.accessToken;};
  beforeAll(async()=>{const setup=createDataSource();await setup.initialize();await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await setup.runMigrations();await seedDatabase(setup,false);await setup.destroy();const mod=await Test.createTestingModule({imports:[AppModule]}).compile();app=mod.createNestApplication();configureApp(app);await app.init();db=app.get(DataSource);admin=await login('admin');warehouse=await login('warehouse');production=await login('production');});
  afterAll(async()=>{await app.close();});

  it('连续执行物料/BOM至出库、幂等、负库存和对账',async()=>{
    for(const item of [
      {itemCode:'M-001',name:'电机',itemType:'MATERIAL',unit:'个'},
      {itemCode:'M-002',name:'外壳',itemType:'MATERIAL',unit:'个'},
      {itemCode:'M-003',name:'螺丝',itemType:'MATERIAL',unit:'个'},
      {itemCode:'FG-001',name:'监测终端',itemType:'FINISHED_GOOD',unit:'台'},
    ]){const r=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send(item).expect(201);ids[item.itemCode]=r.body.data.id;}
    await request(app.getHttpServer()).post('/api/boms').set(auth(admin)).send({finishedGoodId:ids['FG-001'],version:'V1',status:'ACTIVE',lines:[{materialId:ids['M-001'],qtyPer:'1'},{materialId:ids['M-002'],qtyPer:'1'},{materialId:ids['M-003'],qtyPer:'4'}]}).expect(201);
    let r=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'100'},{itemId:ids['M-002'],quantity:'100'},{itemId:ids['M-003'],quantity:'300'}]}).expect(201);ids.inbound=r.body.data.id;
    await request(app.getHttpServer()).post(`/api/stock-documents/${ids.inbound}/post`).set(auth(warehouse)).set('Idempotency-Key','accept-inbound').send({}).expect(201);
    await expectBalances({RAW:{'M-001':'100.0000','M-002':'100.0000','M-003':'300.0000'}});
    r=await request(app.getHttpServer()).post('/api/production-orders').set(auth(production)).send({finishedGoodId:ids['FG-001'],plannedQty:'10'}).expect(201);ids.order=r.body.data.id;
    expect(r.body.data.materials.map((x:any)=>x.requiredQty)).toEqual(['10.0000','10.0000','40.0000']);
    await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/release`).set(auth(production)).send({}).expect(201);
    const issue={lines:[{materialId:ids['M-001'],quantity:'10'},{materialId:ids['M-002'],quantity:'10'},{materialId:ids['M-003'],quantity:'40'}]};
    await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/issue`).set(auth(warehouse)).set('Idempotency-Key','accept-issue').send(issue).expect(201);
    await expectBalances({RAW:{'M-001':'90.0000','M-002':'90.0000','M-003':'260.0000'}});
    await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/return`).set(auth(warehouse)).set('Idempotency-Key','accept-return').send({lines:[{materialId:ids['M-003'],quantity:'1'}]}).expect(201);
    await expectBalances({RAW:{'M-003':'261.0000'}});r=await request(app.getHttpServer()).get(`/api/production-orders/${ids.order}`).set(auth(admin)).expect(200);expect(r.body.data.materials.find((x:any)=>x.itemCode==='M-003').netIssuedQty).toBe('39.0000');
    await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/complete`).set(auth(production)).set('Idempotency-Key','accept-complete-6').send({quantity:'6'}).expect(201);await expectBalances({FG:{'FG-001':'6.0000'}});
    await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/complete`).set(auth(production)).set('Idempotency-Key','accept-complete-4').send({quantity:'4'}).expect(201);await expectBalances({FG:{'FG-001':'10.0000'}});r=await request(app.getHttpServer()).get(`/api/production-orders/${ids.order}`).set(auth(admin)).expect(200);expect(r.body.data.status).toBe('COMPLETED');
    r=await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'3'}]}).expect(201);ids.outbound=r.body.data.id;
    const first=await request(app.getHttpServer()).post(`/api/stock-documents/${ids.outbound}/post`).set(auth(warehouse)).set('Idempotency-Key','accept-outbound').send({}).expect(201);
    const repeat=await request(app.getHttpServer()).post(`/api/stock-documents/${ids.outbound}/post`).set(auth(warehouse)).set('Idempotency-Key','accept-outbound').send({}).expect(201);expect(repeat.body.data).toEqual(first.body.data);await expectBalances({FG:{'FG-001':'7.0000'}});
    r=await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'8'}]}).expect(201);await request(app.getHttpServer()).post(`/api/stock-documents/${r.body.data.id}/post`).set(auth(warehouse)).set('Idempotency-Key','accept-negative').send({}).expect(409);await expectBalances({FG:{'FG-001':'7.0000'}});
    const cockpit=await request(app.getHttpServer()).get('/api/dashboard/cockpit?days=14').set(auth(admin)).expect(200);
    expect(cockpit.body.data.kpis).toMatchObject({materialSkuCount:3,finishedGoodSkuCount:1,inventoryRiskSkuCount:0,activeProductionOrderCount:0});
    expect(cockpit.body.data.productionStatus.find((x:any)=>x.status==='COMPLETED').count).toBe(1);
    expect(cockpit.body.data.movementTrend).toHaveLength(14);
    await request(app.getHttpServer()).get('/api/dashboard/cockpit?days=7').set(auth(warehouse)).expect(200);
    await request(app.getHttpServer()).get('/api/dashboard/cockpit?days=30').set(auth(production)).expect(200);
    await request(app.getHttpServer()).get('/api/dashboard/cockpit?days=15').set(auth(admin)).expect(400);
    const mismatch=await db.query(`SELECT w.warehouse_code,i.item_code,b.on_hand_qty,COALESCE(sum(t.delta_qty),0) tx_qty FROM stock_balances b JOIN warehouses w ON w.id=b.warehouse_id JOIN items i ON i.id=b.item_id LEFT JOIN stock_transactions t ON t.warehouse_id=b.warehouse_id AND t.item_id=b.item_id GROUP BY w.warehouse_code,i.item_code,b.on_hand_qty HAVING b.on_hand_qty<>COALESCE(sum(t.delta_qty),0)`);expect(mismatch).toEqual([]);
    await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(production)).send({lines:[{itemId:ids['FG-001'],quantity:'1'}]}).expect(403);
  });
  it('已过账单据冲销生成反向流水且恢复余额',async()=>{
    const draft=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'5'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/post`).set(auth(warehouse)).set('Idempotency-Key','void-source').send({}).expect(201);
    await expectBalances({RAW:{'M-001':'95.0000'}});
    const reversed=await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/void`).set(auth(warehouse)).set('Idempotency-Key','void-reverse').send({reason:'自动化冲销验证'}).expect(201);
    expect(reversed.body.data.documentType).toBe('REVERSAL');
    await expectBalances({RAW:{'M-001':'90.0000'}});
  });

  it('独立成品入库支持草稿、幂等过账、权限和冲销',async()=>{
    const before=await balanceOf('FG','FG-001');
    expect(before).toBe('7.0000');
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(production)).send({lines:[{itemId:ids['FG-001'],quantity:'5'}]}).expect(403);
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'5'}]}).expect(400);
    const inactive=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({itemCode:'FG-INACTIVE',name:'停用成品',itemType:'FINISHED_GOOD',unit:'台'}).expect(201);
    await request(app.getHttpServer()).patch(`/api/items/${inactive.body.data.id}`).set(auth(admin)).send({status:'INACTIVE'}).expect(200);
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({lines:[{itemId:inactive.body.data.id,quantity:'1'}]}).expect(400);

    const draft=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({notes:'非生产来源成品',lines:[{itemId:ids['FG-001'],quantity:'5'}]}).expect(201);
    ids.finishedInbound=draft.body.data.id;
    expect(draft.body.data.documentType).toBe('FINISHED_INBOUND');
    expect(draft.body.data.documentNo).toMatch(/^FI-/);
    await expectBalances({FG:{'FG-001':'7.0000'}});
    const first=await request(app.getHttpServer()).post(`/api/stock-documents/${ids.finishedInbound}/post`).set(auth(warehouse)).set('Idempotency-Key','finished-inbound-post').send({}).expect(201);
    const repeated=await request(app.getHttpServer()).post(`/api/stock-documents/${ids.finishedInbound}/post`).set(auth(warehouse)).set('Idempotency-Key','finished-inbound-post').send({}).expect(201);
    expect(repeated.body.data).toEqual(first.body.data);
    await expectBalances({FG:{'FG-001':'12.0000'}});
    await request(app.getHttpServer()).patch(`/api/stock-documents/${ids.finishedInbound}`).set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'6'}]}).expect(400);
    await request(app.getHttpServer()).delete(`/api/stock-documents/${ids.finishedInbound}`).set(auth(warehouse)).expect(400);

    const conflictDraft=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'1'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${conflictDraft.body.data.id}/post`).set(auth(warehouse)).set('Idempotency-Key','finished-inbound-post').send({}).expect(409);
    await request(app.getHttpServer()).delete(`/api/stock-documents/${conflictDraft.body.data.id}`).set(auth(warehouse)).expect(200);
    await expectBalances({FG:{'FG-001':'12.0000'}});

    const cockpit=await request(app.getHttpServer()).get('/api/dashboard/cockpit?days=14').set(auth(warehouse)).expect(200);
    expect(cockpit.body.data.movementTrend.reduce((sum:number,row:any)=>sum+row.finishedInboundDocumentCount,0)).toBe(1);
    const reversed=await request(app.getHttpServer()).post(`/api/stock-documents/${ids.finishedInbound}/void`).set(auth(warehouse)).set('Idempotency-Key','finished-inbound-void').send({reason:'手工成品入库冲销验证'}).expect(201);
    expect(reversed.body.data.documentType).toBe('REVERSAL');
    await expectBalances({FG:{'FG-001':'7.0000'}});
    const original=await request(app.getHttpServer()).get(`/api/stock-documents/${ids.finishedInbound}`).set(auth(admin)).expect(200);
    expect(original.body.data.status).toBe('VOIDED');
    const deltas=await db.query(`SELECT delta_qty FROM stock_transactions WHERE source_document_id IN ($1,$2) ORDER BY created_at`,[ids.finishedInbound,reversed.body.data.id]);
    expect(deltas.map((row:any)=>row.delta_qty)).toEqual(['5.0000','-5.0000']);
  });

  it('同一成品库存并发出库时不会产生负库存',async()=>{
    const drafts:any[]=[];
    for(let i=0;i<10;i++){const r=await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'1'}]}).expect(201);drafts.push(r.body.data.id);}
    const results=await Promise.all(drafts.map((documentId,index)=>request(app.getHttpServer()).post(`/api/stock-documents/${documentId}/post`).set(auth(warehouse)).set('Idempotency-Key',`concurrent-${index}`).send({})));
    expect(results.filter(r=>r.status===201)).toHaveLength(7);
    expect(results.filter(r=>r.status===409)).toHaveLength(3);
    await expectBalances({FG:{'FG-001':'0.0000'}});
  });

  it('管理员可设置自定义重置密码，旧密码立即失效', async () => {
    const users = await request(app.getHttpServer()).get('/api/users?pageSize=100').set(auth(admin)).expect(200);
    const target = users.body.data.items.find((user: any) => user.username === 'production');
    await request(app.getHttpServer()).post(`/api/users/${target.id}/reset-password`).set(auth(admin)).send({ password: 'NewDemo@2026' }).expect(201);
    await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'production', password: 'Demo@123456' }).expect(401);
    await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'production', password: 'NewDemo@2026' }).expect(201);
  });

  async function balanceOf(warehouseCode:string,itemCode:string){const r=await request(app.getHttpServer()).get('/api/inventory/balances?pageSize=100').set(auth(admin)).expect(200);return r.body.data.items.find((x:any)=>x.warehouseCode===warehouseCode&&x.itemCode===itemCode)?.onHandQty;}
  async function expectBalances(expected:any){for(const[warehouseCode,items]of Object.entries(expected) as any)for(const[itemCode,value]of Object.entries(items) as any)expect(await balanceOf(warehouseCode,itemCode)).toBe(value);}
});
