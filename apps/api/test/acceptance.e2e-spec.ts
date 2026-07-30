import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { seedDatabase } from '../src/database/seed';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';

describe('库存管理固定验收场景',()=>{
  let app:INestApplication,db:DataSource,adminDb:DataSource|undefined;let admin='',warehouse='',production='';const ids:any={};
  const uploadRoot=join(tmpdir(),`inventory-item-images-${Date.now()}`);
  const originalDatabaseUrl=process.env.DATABASE_URL;
  const originalDatabaseName=process.env.POSTGRES_DB;
  const e2eDatabase=process.env.E2E_TEST_DB||'inventory_e2e_test';
  const auth=(token:string)=>({Authorization:`Bearer ${token}`});
  const login=async(username:string)=>{const r=await request(app.getHttpServer()).post('/api/auth/login').send({username,password:'Demo@123456'}).expect(201);return r.body.data.accessToken;};
  beforeAll(async()=>{
    process.env.UPLOAD_ROOT=uploadRoot;
    if(process.env.E2E_DATABASE_URL){
      process.env.DATABASE_URL=process.env.E2E_DATABASE_URL;
    }else{
      if(!/^[a-zA-Z0-9_]+$/.test(e2eDatabase))throw new Error('E2E_TEST_DB contains invalid characters');
      delete process.env.DATABASE_URL;
      adminDb=new DataSource({type:'postgres',host:process.env.POSTGRES_HOST||'localhost',port:Number(process.env.POSTGRES_PORT||5434),database:'postgres',username:process.env.POSTGRES_USER||'inventory',password:process.env.POSTGRES_PASSWORD||'inventory_dev'});
      await adminDb.initialize();
      await adminDb.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,[e2eDatabase]);
      await adminDb.query(`DROP DATABASE IF EXISTS "${e2eDatabase}"`);
      await adminDb.query(`CREATE DATABASE "${e2eDatabase}"`);
      process.env.POSTGRES_DB=e2eDatabase;
    }
    const setup=createDataSource();await setup.initialize();await setup.runMigrations();await seedDatabase(setup,false);await setup.destroy();
    const [{AppModule},{configureApp}]=await Promise.all([import('../src/app.module'),import('../src/main')]);
    const mod=await Test.createTestingModule({imports:[AppModule]}).compile();app=mod.createNestApplication();configureApp(app);await app.init();db=app.get(DataSource);admin=await login('admin');warehouse=await login('warehouse');production=await login('production');
  });
  afterAll(async()=>{
    await app?.close();await fs.rm(uploadRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    if(adminDb){
      await adminDb.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,[e2eDatabase]);
      await adminDb.query(`DROP DATABASE IF EXISTS "${e2eDatabase}"`);
      await adminDb.destroy();
    }
    if(originalDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=originalDatabaseUrl;
    if(originalDatabaseName===undefined)delete process.env.POSTGRES_DB;else process.env.POSTGRES_DB=originalDatabaseName;
  });

  it('连续执行物料/BOM至出库、幂等、负库存和对账',async()=>{
    for(const item of [
      {itemCode:'M-001',name:'电机',itemType:'MATERIAL',unit:'个'},
      {itemCode:'M-002',name:'外壳',itemType:'MATERIAL',unit:'个'},
      {itemCode:'M-003',name:'螺丝',itemType:'MATERIAL',unit:'个'},
      {itemCode:'FG-001',name:'监测终端',itemType:'FINISHED_GOOD',unit:'台'},
    ]){const r=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send(item).expect(201);ids[item.itemCode]=r.body.data.id;}
    await request(app.getHttpServer()).post('/api/boms').set(auth(admin)).send({finishedGoodId:ids['FG-001'],version:'V1',status:'ACTIVE',lines:[{materialId:ids['M-001'],qtyPer:'1'},{materialId:ids['M-002'],qtyPer:'1'},{materialId:ids['M-003'],qtyPer:'4'}]}).expect(201);
    let r=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'100'},{itemId:ids['M-002'],quantity:'100'},{itemId:ids['M-003'],quantity:'300'}]}).expect(201);ids.inbound=r.body.data.id;
    await submitApprove(ids.inbound,'accept-inbound');
    await expectBalances({RAW:{'M-001':'100','M-002':'100','M-003':'300'}});
    r=await request(app.getHttpServer()).post('/api/production-orders').set(auth(production)).send({finishedGoodId:ids['FG-001'],plannedQty:'10'}).expect(201);ids.order=r.body.data.id;
    expect(r.body.data.orderNo).toMatch(/^SCRW-\d{14}(?:-\d{2,})?$/);
    expect(r.body.data.materials.map((x:any)=>x.requiredQty)).toEqual(['10','10','40']);
    await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/release`).set(auth(production)).send({}).expect(201);
    const issue={lines:[{materialId:ids['M-001'],quantity:'10'},{materialId:ids['M-002'],quantity:'10'},{materialId:ids['M-003'],quantity:'40'}]};
    r=await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/issue`).set(auth(warehouse)).set('Idempotency-Key','accept-issue-create').send(issue).expect(201);
    expect(r.body.data.documentNo).toMatch(/^SCLL-\d{14}(?:-\d{2,})?$/);
    await submitApprove(r.body.data.id,'accept-issue');
    await expectBalances({RAW:{'M-001':'90','M-002':'90','M-003':'260'}});
    r=await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/return`).set(auth(warehouse)).set('Idempotency-Key','accept-return-create').send({lines:[{materialId:ids['M-003'],quantity:'1'}]}).expect(201);
    await submitApprove(r.body.data.id,'accept-return');
    await expectBalances({RAW:{'M-003':'261'}});r=await request(app.getHttpServer()).get(`/api/production-orders/${ids.order}`).set(auth(admin)).expect(200);expect(r.body.data.materials.find((x:any)=>x.itemCode==='M-003').netIssuedQty).toBe('39');
    r=await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/complete`).set(auth(production)).set('Idempotency-Key','accept-complete-6-create').send({quantity:'6'}).expect(201);await submitApprove(r.body.data.id,'accept-complete-6');await expectBalances({FG:{'FG-001':'6'}});
    r=await request(app.getHttpServer()).post(`/api/production-orders/${ids.order}/complete`).set(auth(production)).set('Idempotency-Key','accept-complete-4-create').send({quantity:'4'}).expect(201);await submitApprove(r.body.data.id,'accept-complete-4');await expectBalances({FG:{'FG-001':'10'}});r=await request(app.getHttpServer()).get(`/api/production-orders/${ids.order}`).set(auth(admin)).expect(200);expect(r.body.data.status).toBe('COMPLETED');
    r=await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'3'}]}).expect(201);ids.outbound=r.body.data.id;
    await request(app.getHttpServer()).post(`/api/stock-documents/${ids.outbound}/submit`).set(auth(warehouse)).send({}).expect(201);
    const first=await request(app.getHttpServer()).post(`/api/approvals/${ids.outbound}/approve`).set(auth(admin)).set('Idempotency-Key','accept-outbound').send({}).expect(201);
    const repeat=await request(app.getHttpServer()).post(`/api/approvals/${ids.outbound}/approve`).set(auth(admin)).set('Idempotency-Key','accept-outbound').send({}).expect(201);expect(repeat.body.data).toEqual(first.body.data);await expectBalances({FG:{'FG-001':'7'}});
    r=await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'8'}]}).expect(201);await request(app.getHttpServer()).post(`/api/stock-documents/${r.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(409);await expectBalances({FG:{'FG-001':'7'}});
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
    await submitApprove(draft.body.data.id,'void-source');
    await expectBalances({RAW:{'M-001':'95'}});
    const reversed=await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/void`).set(auth(warehouse)).set('Idempotency-Key','void-reverse').send({reason:'自动化冲销验证'}).expect(201);
    expect(reversed.body.data.documentType).toBe('REVERSAL');
    expect(reversed.body.data.documentNo).toMatch(/^CX-\d{14}(?:-\d{2,})?$/);
    await expectBalances({RAW:{'M-001':'90'}});
  });

  it('当前库存按仓库和物料汇总并可分别查询入出库流水',async()=>{
    const [raw]=await db.query(`SELECT id FROM warehouses WHERE warehouse_code='RAW'`);
    const [zone]=await db.query(`SELECT id FROM warehouse_zones WHERE warehouse_id=$1 ORDER BY sequence_no LIMIT 1`,[raw.id]);
    const [extraLocation]=await db.query(
      `INSERT INTO warehouse_locations(id,warehouse_id,zone_id,code,name,status,sort_order,auto_generated)
       VALUES(gen_random_uuid(),$1,$2,'E2E-SUMMARY-01','汇总测试库位','ACTIVE',999,false)
       RETURNING id`,
      [raw.id,zone.id],
    );
    await db.query(
      `INSERT INTO stock_balances(id,warehouse_id,location_id,item_id,on_hand_qty,frozen_qty)
       VALUES(gen_random_uuid(),$1,$2,$3,0,0)`,
      [raw.id,extraLocation.id,ids['M-001']],
    );
    const balances=await request(app.getHttpServer())
      .get(`/api/inventory/balances?warehouseId=${raw.id}&itemId=${ids['M-001']}&pageSize=100`)
      .set(auth(admin)).expect(200);
    expect(balances.body.data.items.length).toBeGreaterThan(1);
    const expectedQty=balances.body.data.items.reduce((sum:number,row:any)=>sum+Number(row.onHandQty),0).toFixed(0);
    const report=await request(app.getHttpServer())
      .get(`/api/inventory/reports/current?warehouseId=${raw.id}&itemId=${ids['M-001']}&pageSize=20`)
      .set(auth(admin)).expect(200);
    expect(report.body.data.total).toBe(1);
    expect(report.body.data.items[0]).toEqual(expect.objectContaining({
      itemCode:'M-001',
      onHandQty:expectedQty,
      locationCount:balances.body.data.items.length,
      inventoryRecordCount:balances.body.data.items.length,
      availableQty:expect.any(String),
      frozenQty:expect.any(String),
      reservedQty:expect.any(String),
    }));
    expect(report.body.data.items[0]).not.toHaveProperty('batchNo');
    const inbound=await request(app.getHttpServer())
      .get(`/api/inventory/transactions?warehouseId=${raw.id}&itemId=${ids['M-001']}&direction=IN&pageSize=100`)
      .set(auth(admin)).expect(200);
    const outbound=await request(app.getHttpServer())
      .get(`/api/inventory/transactions?warehouseId=${raw.id}&itemId=${ids['M-001']}&direction=OUT&pageSize=100`)
      .set(auth(admin)).expect(200);
    expect(inbound.body.data.items.length).toBeGreaterThan(0);
    expect(outbound.body.data.items.length).toBeGreaterThan(0);
    expect(inbound.body.data.items.every((row:any)=>Number(row.deltaQty)>0)).toBe(true);
    expect(outbound.body.data.items.every((row:any)=>Number(row.deltaQty)<0)).toBe(true);
    await request(app.getHttpServer()).get('/api/inventory/transactions?direction=INVALID').set(auth(admin)).expect(400);
  });

  it('统一库存管理详情、十类报表与生产待办统计可查询', async () => {
    const documents=await request(app.getHttpServer()).get('/api/stock-documents?pageSize=20&sortField=createdAt&sortOrder=DESC').set(auth(admin)).expect(200);
    expect(documents.body.data.items.length).toBeGreaterThan(0);
    const documentDetail=await request(app.getHttpServer()).get(`/api/stock-documents/${documents.body.data.items[0].id}`).set(auth(admin)).expect(200);
    expect(documentDetail.body.data).toEqual(expect.objectContaining({
      lines:expect.any(Array),operationRecords:expect.any(Array),transactions:expect.any(Array),
    }));
    const transactions=await request(app.getHttpServer()).get('/api/inventory/transactions?pageSize=20').set(auth(admin)).expect(200);
    expect(transactions.body.data.items.length).toBeGreaterThan(0);
    await request(app.getHttpServer()).get(`/api/inventory/transactions/${transactions.body.data.items[0].id}`).set(auth(admin)).expect(200);
    for(const reportType of ['current','movement-summary','item-ledger','warehouse-summary','low-stock','zero-stock','defective-stock','aging','batch-stock','production-materials']){
      const report=await request(app.getHttpServer()).get(`/api/inventory/reports/${reportType}?pageSize=20`).set(auth(admin)).expect(200);
      expect(report.body.data).toEqual(expect.objectContaining({
        items:expect.any(Array),total:expect.any(Number),page:1,pageSize:20,summary:expect.any(Object),
      }));
    }
    await request(app.getHttpServer()).get('/api/inventory/reports/current/export').set(auth(admin))
      .expect('Content-Type',/spreadsheetml/).expect(200);
    const productionList=await request(app.getHttpServer()).get('/api/production-orders?status=all&pageSize=100').set(auth(admin)).expect(200);
    expect(productionList.body.data).toEqual(expect.objectContaining({items:expect.any(Array),statistics:expect.any(Object)}));
    expect(productionList.body.data.items[0]).toEqual(expect.objectContaining({
      shortageMaterialCount:expect.any(Number),todoTypes:expect.any(Array),
    }));
  });

  it('独立成品入库支持草稿、幂等过账、权限和冲销',async()=>{
    const before=await balanceOf('FG','FG-001');
    expect(before).toBe('7');
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(production)).send({lines:[{itemId:ids['FG-001'],quantity:'5'}]}).expect(403);
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'5'}]}).expect(400);
    const inactive=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({itemCode:'FG-INACTIVE',name:'停用成品',itemType:'FINISHED_GOOD',unit:'台'}).expect(201);
    await request(app.getHttpServer()).patch(`/api/items/${inactive.body.data.id}`).set(auth(admin)).send({status:'INACTIVE'}).expect(200);
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({lines:[{itemId:inactive.body.data.id,quantity:'1'}]}).expect(400);

    const draft=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({notes:'非生产来源成品',lines:[{itemId:ids['FG-001'],quantity:'5'}]}).expect(201);
    ids.finishedInbound=draft.body.data.id;
    expect(draft.body.data.documentType).toBe('FINISHED_INBOUND');
    expect(draft.body.data.documentNo).toMatch(/^CPRK-\d{14}(?:-\d{2,})?$/);
    await expectBalances({FG:{'FG-001':'7'}});
    await request(app.getHttpServer()).post(`/api/stock-documents/${ids.finishedInbound}/submit`).set(auth(warehouse)).send({}).expect(201);
    const finishedInboundPayload=await approvalPayload(ids.finishedInbound);
    const first=await request(app.getHttpServer()).post(`/api/approvals/${ids.finishedInbound}/approve`).set(auth(admin)).set('Idempotency-Key','finished-inbound-post').send(finishedInboundPayload).expect(201);
    const repeated=await request(app.getHttpServer()).post(`/api/approvals/${ids.finishedInbound}/approve`).set(auth(admin)).set('Idempotency-Key','finished-inbound-post').send(finishedInboundPayload).expect(201);
    expect(repeated.body.data).toEqual(first.body.data);
    await expectBalances({FG:{'FG-001':'12'}});
    await request(app.getHttpServer()).patch(`/api/stock-documents/${ids.finishedInbound}`).set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'6'}]}).expect(400);
    await request(app.getHttpServer()).delete(`/api/stock-documents/${ids.finishedInbound}`).set(auth(warehouse)).expect(400);

    const conflictDraft=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'1'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${conflictDraft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    await request(app.getHttpServer()).post(`/api/approvals/${conflictDraft.body.data.id}/approve`).set(auth(admin)).set('Idempotency-Key','finished-inbound-post').send({}).expect(409);
    await request(app.getHttpServer()).post(`/api/stock-documents/${conflictDraft.body.data.id}/withdraw`).set(auth(warehouse)).send({}).expect(201);
    await request(app.getHttpServer()).delete(`/api/stock-documents/${conflictDraft.body.data.id}`).set(auth(warehouse)).expect(200);
    await expectBalances({FG:{'FG-001':'12'}});

    const cockpit=await request(app.getHttpServer()).get('/api/dashboard/cockpit?days=14').set(auth(warehouse)).expect(200);
    expect(cockpit.body.data.movementTrend.reduce((sum:number,row:any)=>sum+row.finishedInboundDocumentCount,0)).toBe(1);
    const reversed=await request(app.getHttpServer()).post(`/api/stock-documents/${ids.finishedInbound}/void`).set(auth(warehouse)).set('Idempotency-Key','finished-inbound-void').send({reason:'手工成品入库冲销验证'}).expect(201);
    expect(reversed.body.data.documentType).toBe('REVERSAL');
    await expectBalances({FG:{'FG-001':'7'}});
    const original=await request(app.getHttpServer()).get(`/api/stock-documents/${ids.finishedInbound}`).set(auth(admin)).expect(200);
    expect(original.body.data.status).toBe('VOIDED');
    const deltas=await db.query(`SELECT delta_qty FROM stock_transactions WHERE source_document_id IN ($1,$2) ORDER BY created_at`,[ids.finishedInbound,reversed.body.data.id]);
    expect(deltas.map((row:any)=>row.delta_qty)).toEqual(['5','-5']);
  });

  it('整数校验、完工不良品退生产与原材料维修重新入库形成闭环',async()=>{
    await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse))
      .send({lines:[{itemId:ids['M-001'],quantity:'1.1'}]}).expect(400);
    await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse))
      .send({lines:[{itemId:ids['M-001'],quantity:'1e2'}]}).expect(400);

    const rawDraft=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse))
      .send({notes:'原材料不良维修闭环',lines:[{itemId:ids['M-002'],quantity:'2'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${rawDraft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    const rawApproval=(await request(app.getHttpServer()).get(`/api/approvals/${rawDraft.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    const rawLine=rawApproval.lines[0];
    const rawNormal=rawApproval.allocationOptions.find((row:any)=>row.warehouseType==='RAW');
    const rawDefective=rawApproval.allocationOptions.find((row:any)=>row.warehouseType==='DEFECTIVE');
    await request(app.getHttpServer()).post(`/api/approvals/${rawDraft.body.data.id}/approve`).set(auth(admin))
      .set('Idempotency-Key','raw-defective-split').send({receiptAllocations:[
        {documentLineId:rawLine.id,disposition:'NORMAL',warehouseId:rawNormal.warehouseId,locationId:rawNormal.locationId,quantity:'1'},
        {documentLineId:rawLine.id,disposition:'DEFECTIVE',warehouseId:rawDefective.warehouseId,locationId:rawDefective.locationId,quantity:'1',defectReason:'外观损伤'},
      ]}).expect(201);
    const rawLots=(await request(app.getHttpServer()).get('/api/approvals/defective-items?itemType=MATERIAL&pageSize=100').set(auth(admin)).expect(200)).body.data.items;
    const rawLot=rawLots.find((row:any)=>row.sourceDocumentNo===rawApproval.documentNo);
    expect(rawLot).toEqual(expect.objectContaining({remainingQty:'1',defectReason:'外观损伤'}));
    const repaired=await request(app.getHttpServer()).post(`/api/approvals/defective-items/${rawLot.id}/process`).set(auth(admin))
      .set('Idempotency-Key','raw-repair-restock').send({action:'REPAIR_RESTOCK',quantity:'1',reason:'更换外壳并复检合格',targetWarehouseId:rawNormal.warehouseId,targetLocationId:rawNormal.locationId}).expect(201);
    expect(repaired.body.data.documentType).toBe('DEFECTIVE_REPAIR_RESTOCK');
    const repairedAgain=await request(app.getHttpServer()).post(`/api/approvals/defective-items/${rawLot.id}/process`).set(auth(admin))
      .set('Idempotency-Key','raw-repair-restock').send({action:'REPAIR_RESTOCK',quantity:'1',reason:'更换外壳并复检合格',targetWarehouseId:rawNormal.warehouseId,targetLocationId:rawNormal.locationId}).expect(201);
    expect(repairedAgain.body.data).toEqual(repaired.body.data);

    const defectFinished=await request(app.getHttpServer()).post('/api/items').set(auth(admin))
      .send({itemCode:'FG-DEFECT-E2E',name:'不良品闭环成品',itemType:'FINISHED_GOOD',unit:'台'}).expect(201);
    await request(app.getHttpServer()).post('/api/boms').set(auth(admin)).send({
      finishedGoodId:defectFinished.body.data.id,version:'V1',status:'ACTIVE',lines:[{materialId:ids['M-001'],qtyPer:'1'}],
    }).expect(201);
    const order=await request(app.getHttpServer()).post('/api/production-orders').set(auth(production))
      .send({finishedGoodId:defectFinished.body.data.id,plannedQty:'2'}).expect(201);
    await request(app.getHttpServer()).post(`/api/production-orders/${order.body.data.id}/release`).set(auth(production)).send({}).expect(201);
    const materialBalance=(await request(app.getHttpServer()).get(`/api/inventory/balances?itemId=${ids['M-001']}&pageSize=100`).set(auth(admin)).expect(200))
      .body.data.items.find((row:any)=>row.warehouseCode==='RAW'&&Number(row.availableQty)>=2);
    const issue=await request(app.getHttpServer()).post(`/api/production-orders/${order.body.data.id}/issue`).set(auth(warehouse))
      .set('Idempotency-Key','defective-e2e-issue-create').send({lines:[{materialId:ids['M-001'],quantity:'2',locationId:materialBalance.locationId,batchId:materialBalance.batchId||undefined}]});
    if(issue.status!==201)throw new Error(`不良品闭环领料创建失败：${JSON.stringify(issue.body)}`);
    await submitApprove(issue.body.data.id,'defective-e2e-issue-approve');
    const completion=await request(app.getHttpServer()).post(`/api/production-orders/${order.body.data.id}/complete`).set(auth(production))
      .set('Idempotency-Key','defective-e2e-complete-create').send({quantity:'2'}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${completion.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    const completionApproval=(await request(app.getHttpServer()).get(`/api/approvals/${completion.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    const completionLine=completionApproval.lines[0];
    const fgTarget=completionApproval.allocationOptions.find((row:any)=>row.warehouseType==='FG');
    const defectTarget=completionApproval.allocationOptions.find((row:any)=>row.warehouseType==='DEFECTIVE');
    await request(app.getHttpServer()).post(`/api/approvals/${completion.body.data.id}/approve`).set(auth(admin))
      .set('Idempotency-Key','defective-e2e-complete-approve').send({receiptAllocations:[
        {documentLineId:completionLine.id,disposition:'NORMAL',warehouseId:fgTarget.warehouseId,locationId:fgTarget.locationId,quantity:'1'},
        {documentLineId:completionLine.id,disposition:'DEFECTIVE',warehouseId:defectTarget.warehouseId,locationId:defectTarget.locationId,quantity:'1',defectReason:'功能测试失败'},
      ]}).expect(201);
    let orderDetail=(await request(app.getHttpServer()).get(`/api/production-orders/${order.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    expect(orderDetail).toMatchObject({completedQty:'1',status:'IN_PROGRESS'});
    const finishedLots=(await request(app.getHttpServer()).get('/api/approvals/defective-items?itemType=FINISHED_GOOD&pageSize=100').set(auth(admin)).expect(200)).body.data.items;
    const finishedLot=finishedLots.find((row:any)=>row.sourceDocumentNo===completionApproval.documentNo);
    expect(finishedLot).toEqual(expect.objectContaining({productionOrderId:order.body.data.id,remainingQty:'1'}));
    const returned=await request(app.getHttpServer()).post(`/api/approvals/defective-items/${finishedLot.id}/process`).set(auth(admin))
      .set('Idempotency-Key','finished-return-production').send({action:'RETURN_PRODUCTION',quantity:'1',reason:'返工并重新进行功能测试'}).expect(201);
    expect(returned.body.data.documentType).toBe('DEFECTIVE_PRODUCTION_RETURN');
    const finalCompletion=await request(app.getHttpServer()).post(`/api/production-orders/${order.body.data.id}/complete`).set(auth(production))
      .set('Idempotency-Key','defective-e2e-final-create').send({quantity:'1'}).expect(201);
    await submitApprove(finalCompletion.body.data.id,'defective-e2e-final-approve');
    orderDetail=(await request(app.getHttpServer()).get(`/api/production-orders/${order.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    expect(orderDetail).toMatchObject({completedQty:'2',status:'COMPLETED'});
    const records=(await request(app.getHttpServer()).get('/api/approvals/defective-records?pageSize=100').set(auth(admin)).expect(200)).body.data.items;
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({action:'REPAIR_RESTOCK',quantity:'1'}),
      expect.objectContaining({action:'RETURN_PRODUCTION',quantity:'1',productionOrderNo:order.body.data.orderNo}),
    ]));
  });

  it('同一成品库存并发出库时不会产生负库存',async()=>{
    const created=await Promise.all(Array.from({length:10},()=>request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({lines:[{itemId:ids['FG-001'],quantity:'1'}]})));
    expect(created.every(result=>result.status===201)).toBe(true);
    const documentNumbers=created.map(result=>result.body.data.documentNo);
    expect(new Set(documentNumbers).size).toBe(10);
    expect(documentNumbers.every(number=>/^CPCK-\d{14}(?:-\d{2,})?$/.test(number))).toBe(true);
    const drafts=created.map(result=>result.body.data.id);
    const submitted:any[]=[];
    for(const documentId of drafts){const result=await request(app.getHttpServer()).post(`/api/stock-documents/${documentId}/submit`).set(auth(warehouse)).send({});if(result.status===201)submitted.push(documentId);}
    expect(submitted).toHaveLength(7);
    const results=await Promise.all(submitted.map((documentId,index)=>request(app.getHttpServer()).post(`/api/approvals/${documentId}/approve`).set(auth(admin)).set('Idempotency-Key',`concurrent-${index}`).send({})));
    expect(results.filter(r=>r.status===201)).toHaveLength(7);
    await expectBalances({FG:{'FG-001':'0'}});
  });

  it('V1.1.0 主数据、动态角色、审批状态和库存调整可完整运行',async()=>{
    const version=await request(app.getHttpServer()).get('/api/system/version').expect(200);
    expect(version.body.data.version).toBe('1.3.1');

    const [adminRole]=await db.query(`SELECT id FROM roles WHERE code='ADMIN'`);
    const legacyUser=await request(app.getHttpServer()).post('/api/users').set(auth(admin)).send({
      username:'legacy-name-user',name:'旧客户端姓名',roleId:adminRole.id,password:'68182170',
    }).expect(201);
    expect(legacyUser.body.data.employeeName).toBe('旧客户端姓名');
    const canonicalUser=await request(app.getHttpServer()).post('/api/users').set(auth(admin)).send({
      username:'employee-name-user',employeeName:'新客户端姓名',roleId:adminRole.id,password:'68182170',
    }).expect(201);
    expect(canonicalUser.body.data.employeeName).toBe('新客户端姓名');
    await request(app.getHttpServer()).post(`/api/users/${legacyUser.body.data.id}/delete`).set(auth(admin)).send({}).expect(201);
    await request(app.getHttpServer()).post(`/api/users/${canonicalUser.body.data.id}/delete`).set(auth(admin)).send({}).expect(201);

    const category=await request(app.getHttpServer()).post('/api/item-categories').set(auth(admin)).send({code:'TEST-CAT',name:'测试分类',itemType:'MATERIAL',sortOrder:10}).expect(201);
    const finishedCategory=await request(app.getHttpServer()).post('/api/item-categories').set(auth(warehouse)).send({code:'TEST-CAT',name:'成品测试分类',itemType:'FINISHED_GOOD'}).expect(201);
    await request(app.getHttpServer()).post('/api/item-categories').set(auth(admin)).send({code:'TEST-CAT',name:'重复分类',itemType:'MATERIAL'}).expect(409);
    await request(app.getHttpServer()).post('/api/item-categories').set(auth(production)).send({code:'NO-AUTH',name:'越权分类',itemType:'MATERIAL'}).expect(403);
    const rawCategories=await request(app.getHttpServer()).get('/api/item-categories?itemType=MATERIAL&pageSize=100').set(auth(production)).expect(200);
    expect(rawCategories.body.data.items.every((row:any)=>row.itemType==='MATERIAL')).toBe(true);
    expect(rawCategories.body.data.items.some((row:any)=>row.id===finishedCategory.body.data.id)).toBe(false);
    await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({
      itemCode:'CATEGORY-MISMATCH',name:'错误分类物料',itemType:'MATERIAL',unit:'个',categoryId:finishedCategory.body.data.id,
    }).expect(400);
    await request(app.getHttpServer()).patch(`/api/item-categories/${category.body.data.id}`).set(auth(admin)).send({code:'TEST-CAT-EDIT',name:'测试分类-已修改'}).expect(200);
    await request(app.getHttpServer()).delete(`/api/item-categories/${category.body.data.id}`).set(auth(admin)).expect(200);
    await request(app.getHttpServer()).delete(`/api/item-categories/${finishedCategory.body.data.id}`).set(auth(warehouse)).expect(200);

    expect(rawCategories.body.data.items.every((row:any)=>row.systemProtected===false)).toBe(true);
    const defaults=await db.query(`SELECT item_type,system_protected FROM item_categories WHERE code='UNCATEGORIZED' ORDER BY item_type`);
    expect(defaults.every((row:any)=>row.system_protected===false)).toBe(true);

    const typeChangeCategory=await request(app.getHttpServer()).post('/api/item-categories').set(auth(admin)).send({code:'TYPE-CHANGE',name:'类型变更测试',itemType:'MATERIAL'}).expect(201);
    const typeChangeItem=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({
      itemCode:'TYPE-CHANGE-ITEM',name:'类型变更物料',itemType:'MATERIAL',unit:'个',categoryId:typeChangeCategory.body.data.id,
    }).expect(201);
    const categoryDelete=await request(app.getHttpServer()).delete(`/api/item-categories/${typeChangeCategory.body.data.id}`).set(auth(admin)).expect(200);
    expect(categoryDelete.body.data.detachedItemCount).toBe(1);
    await request(app.getHttpServer()).patch(`/api/items/${typeChangeItem.body.data.id}`).set(auth(admin)).send({itemType:'FINISHED_GOOD'}).expect(200);
    const changedItem=await request(app.getHttpServer()).get(`/api/items/${typeChangeItem.body.data.id}`).set(auth(admin)).expect(200);
    expect(changedItem.body.data.categoryId).toBeNull();

    const permissions=await request(app.getHttpServer()).get('/api/permissions').set(auth(admin)).expect(200);
    expect(permissions.body.data.some((permission:any)=>permission.code==='inventory.view')).toBe(true);
    const role=await request(app.getHttpServer()).post('/api/roles').set(auth(admin)).send({code:'AUDITOR',name:'库存审计员',permissions:['inventory.view','system.version.view']}).expect(201);
    expect(role.body.data.permissions).toEqual(expect.arrayContaining(['inventory.view','system.version.view']));

    const draft=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'2'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/post`).set(auth(warehouse)).set('Idempotency-Key','deprecated-direct-post').send({}).expect(404);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/approve`).set(auth(admin)).send({}).expect(404);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/reject`).set(auth(admin)).send({reason:'旧入口'}).expect(404);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    expect((await request(app.getHttpServer()).get(`/api/stock-documents/${draft.body.data.id}`).set(auth(admin)).expect(200)).body.data.status).toBe('SUBMITTED');
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/withdraw`).set(auth(warehouse)).send({}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/reject`).set(auth(admin)).set('Idempotency-Key','reject-from-center').send({reason:'数量依据不足'}).expect(201);
    await request(app.getHttpServer()).patch(`/api/stock-documents/${draft.body.data.id}`).set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'2'}],notes:'补充依据'}).expect(200);
    await submitApprove(draft.body.data.id,'approval-state-machine');

    const warehouses=await request(app.getHttpServer()).get('/api/warehouses').set(auth(admin)).expect(200);
    const raw=warehouses.body.data.find((row:any)=>row.warehouseCode==='RAW');
    const locations=await request(app.getHttpServer()).get(`/api/warehouse-locations?warehouseId=${raw.id}&pageSize=100`).set(auth(admin)).expect(200);
    const location=locations.body.data.items[0];
    const adjustment=await request(app.getHttpServer()).post('/api/stock-documents/inventory-adjustment').set(auth(warehouse)).send({warehouseId:raw.id,lines:[{itemId:ids['M-001'],locationId:location.id,adjustmentQty:'2'}],notes:'自动化调整'}).expect(201);
    await submitApprove(adjustment.body.data.id,'inventory-adjustment');
    const reconciliation=await request(app.getHttpServer()).get('/api/inventory/reconciliation').set(auth(admin)).expect(200);
    expect(reconciliation.body.data).toMatchObject({consistent:true,differences:[]});
    await request(app.getHttpServer()).get('/api/inventory/export').set(auth(admin)).expect('Content-Type',/text\/csv/).expect(200);
  });

  it('三类物料独立查询、仓库权限和单图压缩替换删除可用', async () => {
    const semi=await request(app.getHttpServer()).post('/api/items').set(auth(warehouse)).send({
      code:'M-IMG-001',name:'图片测试原材料',type:'MATERIAL',unit:'个',safetyStock:'2',remark:'图片测试',
    }).expect(201);
    expect(semi.body.data.itemType).toBe('MATERIAL');
    await request(app.getHttpServer()).patch(`/api/items/${semi.body.data.id}`).set(auth(warehouse)).send({name:'装配半成品A',model:'SF-A'}).expect(200);
    await request(app.getHttpServer()).patch(`/api/items/${semi.body.data.id}`).set(auth(warehouse)).send({itemCode:'SF-002'}).expect(403);
    await request(app.getHttpServer()).patch(`/api/items/${semi.body.data.id}`).set(auth(production)).send({name:'越权修改'}).expect(403);

    const raw=await request(app.getHttpServer()).get('/api/items?type=RAW_MATERIAL&pageSize=100').set(auth(production)).expect(200);
    expect(raw.body.data.items.every((item:any)=>item.itemType==='MATERIAL')).toBe(true);
    expect(raw.body.data.items.some((item:any)=>item.itemCode==='FG-001')).toBe(false);
    const finished=await request(app.getHttpServer()).get('/api/items?type=FINISHED_GOOD&pageSize=100').set(auth(production)).expect(200);
    expect(finished.body.data.items.every((item:any)=>item.itemType==='FINISHED_GOOD')).toBe(true);
    await request(app.getHttpServer()).get('/api/items?itemType=MATERIAL&type=FINISHED_GOOD').set(auth(admin)).expect(400);
    await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({itemCode:'M-001',name:'重复物料',itemType:'MATERIAL',unit:'个'}).expect(409);

    const firstImage=await sharp({
      create:{width:2400,height:1800,channels:4,background:{r:20,g:120,b:220,alpha:0.6}},
    }).jpeg({quality:95}).toBuffer();
    const uploaded=await request(app.getHttpServer()).post(`/api/items/${semi.body.data.id}/image`).set(auth(warehouse))
      .attach('file',firstImage,{filename:'large.jpg',contentType:'image/jpeg'}).expect(201);
    expect(uploaded.body.data.imageUrl).toMatch(/^\/uploads\/items\/[0-9a-f-]+\.webp$/);
    expect(uploaded.body.data.thumbnailUrl).toMatch(/_thumb\.webp$/);
    expect(uploaded.body.data.width).toBeLessThanOrEqual(1600);
    expect(uploaded.body.data.height).toBeLessThanOrEqual(1600);
    const firstMain=join(uploadRoot,'items',uploaded.body.data.imageUrl.split('/').pop());
    const firstThumb=join(uploadRoot,'items',uploaded.body.data.thumbnailUrl.split('/').pop());
    expect((await sharp(await fs.readFile(firstMain)).metadata()).format).toBe('webp');
    expect(await sharp(await fs.readFile(firstThumb)).metadata()).toMatchObject({format:'webp',width:300,height:300});
    await request(app.getHttpServer()).get(uploaded.body.data.thumbnailUrl).expect('Content-Type',/image\/webp/).expect(200);
    await request(app.getHttpServer()).post(`/api/items/${semi.body.data.id}/image`).set(auth(production))
      .attach('file',firstImage,{filename:'blocked.jpg',contentType:'image/jpeg'}).expect(403);
    await request(app.getHttpServer()).post(`/api/items/${semi.body.data.id}/image`).set(auth(warehouse))
      .attach('file',Buffer.from('not-an-image'),{filename:'bad.png',contentType:'image/png'}).expect(400);
    await request(app.getHttpServer()).post(`/api/items/${semi.body.data.id}/image`).set(auth(warehouse))
      .attach('file',Buffer.alloc(10*1024*1024+1),{filename:'too-large.jpg',contentType:'image/jpeg'}).expect(413);

    const replacement=await sharp({create:{width:640,height:480,channels:3,background:'#22aa66'}}).png().toBuffer();
    const replaced=await request(app.getHttpServer()).post(`/api/items/${semi.body.data.id}/image`).set(auth(warehouse))
      .attach('file',replacement,{filename:'replacement.png',contentType:'image/png'}).expect(201);
    await expect(fs.access(firstMain)).rejects.toThrow();
    await expect(fs.access(firstThumb)).rejects.toThrow();
    const replacementPath=join(uploadRoot,'items',replaced.body.data.imageUrl.split('/').pop());
    await fs.unlink(replacementPath);
    await request(app.getHttpServer()).delete(`/api/items/${semi.body.data.id}/image`).set(auth(warehouse)).expect(200);
    const detail=await request(app.getHttpServer()).get(`/api/items/${semi.body.data.id}`).set(auth(admin)).expect(200);
    expect(detail.body.data).toMatchObject({imageUrl:null,thumbnailUrl:null,remark:'图片测试'});
  });

  it('半成品 BOM、生产入库、安全删除及仓库库区联动可用', async () => {
    const rawItem=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({
      itemCode:'RM-PROD',name:'半成品测试原料',itemType:'MATERIAL',unit:'个',
    }).expect(201);
    const semiItem=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({
      itemCode:'FG-PROD',name:'测试成品',itemType:'FINISHED_GOOD',unit:'个',
    }).expect(201);
    const bom=await request(app.getHttpServer()).post('/api/boms').set(auth(admin)).send({
      finishedGoodId:semiItem.body.data.id,version:'V1',status:'ACTIVE',
      lines:[{materialId:rawItem.body.data.id,qtyPer:'1'}],
    }).expect(201);
    await request(app.getHttpServer()).put(`/api/boms/${bom.body.data.id}`).set(auth(admin)).send({
      finishedGoodId:semiItem.body.data.id,version:'V1',status:'ACTIVE',notes:'已编辑',
      lines:[{materialId:rawItem.body.data.id,qtyPer:'1'}],
    }).expect(200);
    await request(app.getHttpServer()).post('/api/boms').set(auth(admin)).send({
      finishedGoodId:semiItem.body.data.id,version:'SELF',status:'INACTIVE',
      lines:[{materialId:semiItem.body.data.id,qtyPer:'1'}],
    }).expect(400);

    const inbound=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse)).send({
      lines:[{itemId:rawItem.body.data.id,quantity:'3'}],
    }).expect(201);
    await submitApprove(inbound.body.data.id,'semi-material-inbound');
    const order=await request(app.getHttpServer()).post('/api/production-orders').set(auth(production)).send({
      finishedGoodId:semiItem.body.data.id,plannedQty:'2',
    }).expect(201);
    expect(order.body.data.outputItemType).toBe('FINISHED_GOOD');
    await request(app.getHttpServer()).post(`/api/production-orders/${order.body.data.id}/release`).set(auth(production)).send({}).expect(201);
    const issue=await request(app.getHttpServer()).post(`/api/production-orders/${order.body.data.id}/issue`).set(auth(warehouse))
      .set('Idempotency-Key','semi-issue-create').send({lines:[{materialId:rawItem.body.data.id,quantity:'2'}]}).expect(201);
    await submitApprove(issue.body.data.id,'semi-issue-approve');
    const completion=await request(app.getHttpServer()).post(`/api/production-orders/${order.body.data.id}/complete`).set(auth(production))
      .set('Idempotency-Key','semi-complete-create').send({quantity:'2'}).expect(201);
    await submitApprove(completion.body.data.id,'semi-complete-approve');
    expect(await balanceOf('FG','FG-PROD')).toBe('2');

    const units=await request(app.getHttpServer()).get('/api/units?pageSize=100&status=ACTIVE').set(auth(admin)).expect(200);
    const unit=units.body.data.items.find((row:any)=>row.name==='个');
    await request(app.getHttpServer()).patch(`/api/items/${rawItem.body.data.id}`).set(auth(admin)).send({
      itemCode:'RM-PROD-EDIT',name:'半成品测试原料-已编辑',unitId:unit.id,
    }).expect(200);
    const archived=await request(app.getHttpServer()).post(`/api/items/${rawItem.body.data.id}/delete`).set(auth(admin)).send({}).expect(201);
    expect(archived.body.data.deletionMode).toBe('ARCHIVED');
    await request(app.getHttpServer()).get(`/api/production-orders/${order.body.data.id}`).set(auth(admin)).expect(200);
    const deletedBom=await request(app.getHttpServer()).delete(`/api/boms/${bom.body.data.id}`).set(auth(admin)).expect(200);
    expect(deletedBom.body.data.deletionMode).toBe('ARCHIVED');

    const createdWarehouse=await request(app.getHttpServer()).post('/api/warehouses').set(auth(admin)).send({
      warehouseCode:'TEST',name:'测试仓库',displayName:'测试仓库',warehouseType:'RAW',status:'ACTIVE',
      zones:[
        {sequenceNo:1,name:'东区',actualLocation:'一号厂房东侧',locationCount:2,status:'ACTIVE'},
        {sequenceNo:2,name:'西区',actualLocation:'一号厂房西侧',locationCount:1,status:'ACTIVE'},
      ],
    }).expect(201);
    expect(createdWarehouse.body.data.zones.map((zone:any)=>zone.code)).toEqual(['TEST01','TEST02']);
    const firstZone=createdWarehouse.body.data.zones[0];
    const editedWarehouse=await request(app.getHttpServer()).patch(`/api/warehouses/${createdWarehouse.body.data.id}`).set(auth(admin)).send({
      warehouseCode:'TESTX',name:'测试仓库-已编辑',displayName:'测试仓库 X',warehouseType:'RAW',status:'ACTIVE',
      zones:[{id:firstZone.id,sequenceNo:3,name:'东区调整',actualLocation:'二号厂房东侧',locationCount:2,status:'ACTIVE'}],
    }).expect(200);
    expect(editedWarehouse.body.data.zones).toEqual([
      expect.objectContaining({code:'TESTX03',actualLocation:'二号厂房东侧'}),
    ]);
    const deletedWarehouse=await request(app.getHttpServer()).delete(`/api/warehouses/${createdWarehouse.body.data.id}`).set(auth(admin)).expect(200);
    expect(deletedWarehouse.body.data.deletionMode).toBe('HARD');
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
  async function approvalPayload(documentId:string){const detail=(await request(app.getHttpServer()).get(`/api/stock-documents/${documentId}`).set(auth(warehouse)).expect(200)).body.data;return ['MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_RETURN','PRODUCTION_COMPLETION'].includes(detail.documentType)?{receiptAllocations:detail.lines.map((line:any)=>({documentLineId:line.id,disposition:'NORMAL',warehouseId:detail.warehouseId,locationId:line.locationId,quantity:line.quantity,batchId:line.batchId||undefined}))}:{};}
  async function submitApprove(documentId:string,key:string){await request(app.getHttpServer()).post(`/api/stock-documents/${documentId}/submit`).set(auth(warehouse)).send({}).expect(201);return request(app.getHttpServer()).post(`/api/approvals/${documentId}/approve`).set(auth(admin)).set('Idempotency-Key',key).send(await approvalPayload(documentId)).expect(201);}
});
