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
import { Workbook } from 'exceljs';
import { prepareBatchInbound } from '../src/database/prepare-batch-inbound';

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
    await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({
      itemCode:'LEGACY-SEMI',name:'不应创建的半成品',itemType:'SEMI_FINISHED',unit:'个',
    }).expect(400);
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
    const [outboundSource] = await db.query(`SELECT b.warehouse_id "warehouseId",b.location_id "locationId" FROM stock_balances b JOIN warehouses w ON w.id=b.warehouse_id WHERE b.item_id=$1 AND w.warehouse_type='FG' AND b.on_hand_qty>0 ORDER BY b.on_hand_qty DESC LIMIT 1`, [ids['FG-001']]);
    ids.outboundSource = outboundSource;
    r=await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({warehouseId:outboundSource.warehouseId,lines:[{itemId:ids['FG-001'],locationId:outboundSource.locationId,quantity:'3'}]}).expect(201);ids.outbound=r.body.data.id;
    await request(app.getHttpServer()).post(`/api/stock-documents/${ids.outbound}/submit`).set(auth(warehouse)).send({}).expect(201);
    const first=await request(app.getHttpServer()).post(`/api/approvals/${ids.outbound}/approve`).set(auth(admin)).set('Idempotency-Key','accept-outbound').send({}).expect(201);
    const repeat=await request(app.getHttpServer()).post(`/api/approvals/${ids.outbound}/approve`).set(auth(admin)).set('Idempotency-Key','accept-outbound').send({}).expect(201);expect(repeat.body.data).toEqual(first.body.data);await expectBalances({FG:{'FG-001':'7'}});
    r=await request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({warehouseId:outboundSource.warehouseId,lines:[{itemId:ids['FG-001'],locationId:outboundSource.locationId,quantity:'8'}]}).expect(201);await request(app.getHttpServer()).post(`/api/stock-documents/${r.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(409);await expectBalances({FG:{'FG-001':'7'}});
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
  it('原材料逐行审批支持重试与并发保护且旧整单接口不能重复过账',async()=>{
    process.env.BATCH_INBOUND_ENABLED='true';
    const beforeM1=await balanceOf('RAW','M-001');const beforeM2=await balanceOf('RAW','M-002');
    const draft=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'2'},{itemId:ids['M-002'],quantity:'3'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    const detail=(await request(app.getHttpServer()).get(`/api/stock-documents/${draft.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    const [first,second]=detail.lines;
    const bad=await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin)).set('Idempotency-Key','test-invalid').send({decisions:[{lineId:first.id,decision:'APPROVED',quantity:'2'}]});
    expect(bad.status).toBe(400);
    const decision={lineId:first.id,decision:'APPROVE',quantity:'2',locationId:first.locationId};
    const once=await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin)).set('Idempotency-Key','pr5-line-one').send({decisions:[decision]}).expect(201);
    const retry=await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin)).set('Idempotency-Key','pr5-line-one').send({decisions:[decision]}).expect(201);
    expect(retry.body.data).toEqual(once.body.data);
    expect(await balanceOf('RAW','M-001')).toBe(String(Number(beforeM1)+2));
    expect(await balanceOf('RAW','M-002')).toBe(beforeM2);
    await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve`).set(auth(admin)).set('Idempotency-Key','test-legacy').send(await approvalPayload(draft.body.data.id)).expect(400);
    const secondDecision={lineId:second.id,decision:'APPROVE',quantity:'3',locationId:second.locationId};
    const concurrent=await Promise.all([
      request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin)).set('Idempotency-Key','pr5-line-two-a').send({decisions:[secondDecision]}),
      request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin)).set('Idempotency-Key','pr5-line-two-b').send({decisions:[secondDecision]}),
    ]);
    expect(concurrent.filter(response=>response.status===201)).toHaveLength(1);
    expect(concurrent.filter(response=>response.status===400)).toHaveLength(1);
    expect(await balanceOf('RAW','M-002')).toBe(String(Number(beforeM2)+3));
    const final=(await request(app.getHttpServer()).get(`/api/stock-documents/${draft.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    expect(final.status).toBe('POSTED');
    expect(final.lines.map((line:any)=>line.reviewStatus)).toEqual(['POSTED','POSTED']);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/void`).set(auth(warehouse)).set('Idempotency-Key','pr5-line-review-cleanup').send({reason:'隔离验收结束后恢复测试基线'}).expect(201);
    expect(await balanceOf('RAW','M-001')).toBe(beforeM1);
    expect(await balanceOf('RAW','M-002')).toBe(beforeM2);
  });
  it('批量入库合并同库位重复行并以幂等键避免重复建单',async()=>{
    process.env.BATCH_INBOUND_ENABLED='true';
    const [target]=await db.query(`SELECT w.warehouse_code warehouse,z.code zone,l.code location FROM warehouses w JOIN warehouse_zones z ON z.warehouse_id=w.id JOIN warehouse_locations l ON l.zone_id=z.id WHERE w.warehouse_type='RAW' AND w.status='ACTIVE' AND z.status='ACTIVE' AND l.status='ACTIVE' AND l.is_archived=false ORDER BY w.warehouse_code,z.code,l.code LIMIT 1`);
    const workbook=new Workbook();const sheet=workbook.addWorksheet('批量入库');
    sheet.addRow(['物料编码','类别','产品名称','规格','数量','单位','所属仓库','库区','库位','备注','批次']);
    sheet.addRow(['M-003','螺丝','螺丝','','2','个',target.warehouse,target.zone,target.location,'批量验收','']);
    sheet.addRow(['M-003','螺丝','螺丝','','3','个',target.warehouse,target.zone,target.location,'批量验收','']);
    const file=Buffer.from(await workbook.xlsx.writeBuffer());
    const post=()=>request(app.getHttpServer()).post('/api/stock-documents/material-inbound/batch-import').set(auth(warehouse)).set('Idempotency-Key','pr5-batch-import-retry').attach('file',file,'batch.xlsx');
    const first=await post().expect(201);const retry=await post().expect(201);
    expect(retry.body.data).toEqual(first.body.data);
    expect(first.body.data).toMatchObject({totalCount:2,successCount:2,failureCount:0,warningCount:1,documents:[{lineCount:1}]});
    const document=first.body.data.documents[0];
    const detail=(await request(app.getHttpServer()).get(`/api/stock-documents/${document.id}`).set(auth(admin)).expect(200)).body.data;
    expect(detail.lines).toHaveLength(1);expect(detail.lines[0].quantity).toBe('5');
    await request(app.getHttpServer()).delete(`/api/stock-documents/${document.id}`).set(auth(warehouse)).expect(200);
  });
  it('批量导入校验批次、仓库权限、数量上限、错误行并支持成品入库',async()=>{
    process.env.BATCH_INBOUND_ENABLED='true';
    const [raw]=await db.query(`SELECT w.id,w.warehouse_code warehouse,z.code zone,l.code location
      FROM warehouses w JOIN warehouse_zones z ON z.warehouse_id=w.id JOIN warehouse_locations l ON l.zone_id=z.id
      WHERE w.warehouse_code='RAW' AND z.status='ACTIVE' AND l.status='ACTIVE' AND l.is_archived=false ORDER BY l.code LIMIT 1`);
    const [unassigned]=await db.query(`INSERT INTO warehouses(warehouse_code,name,warehouse_type)
      VALUES('E2E-UNASSIGNED-RAW','未分配测试仓','RAW') RETURNING id,warehouse_code`);
    const [unassignedZone]=await db.query(`INSERT INTO warehouse_zones(warehouse_id,sequence_no,code,name,actual_location)
      VALUES($1,99,'E2E-ZONE','测试库区','E2E测试位置') RETURNING id` ,[unassigned.id]);
    const [unassignedLocation]=await db.query(`INSERT INTO warehouse_locations(warehouse_id,zone_id,code,name)
      VALUES($1,$2,'E2E-LOCATION','测试库位') RETURNING id`,[unassigned.id,unassignedZone.id]);
    await db.query(`UPDATE items SET enable_batch=true WHERE id=$1`,[ids['M-003']]);
    const batch=await request(app.getHttpServer()).post('/api/batches').set(auth(admin)).send({itemId:ids['M-003'],batchNo:'E2E-BATCH-001'}).expect(201);
    const makeWorkbook=async(rows:any[])=>{
      const workbook=new Workbook();const sheet=workbook.addWorksheet('批量入库');
      sheet.addRow(['物料编码','类别','产品名称','规格','数量','单位','所属仓库','库区','库位','备注','批次']);
      for(const row of rows)sheet.addRow(row);
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };
    const rows=[
      ['M-001','测试','电机','','1','个',raw.warehouse,raw.zone,raw.location,'有效行',''],
      ['M-002','测试','外壳','','0','个',raw.warehouse,raw.zone,raw.location,'数量错误',''],
      ['M-003','测试','螺丝','','1','个',raw.warehouse,raw.zone,raw.location,'缺少批次',''],
      ['M-003','测试','螺丝','','1','个',raw.warehouse,raw.zone,raw.location,'批次有效','E2E-BATCH-001'],
      ['M-001','测试','电机','','1','个',unassigned.warehouse_code,'E2E-ZONE','E2E-LOCATION','无仓库权限',''],
      ['M-002','测试','外壳','','999999999999999999','个',raw.warehouse,raw.zone,raw.location,'合并超限',''],
      ['M-002','测试','外壳','','1','个',raw.warehouse,raw.zone,raw.location,'合并超限',''],
    ];
    const imported=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound/batch-import')
      .set(auth(warehouse)).set('Idempotency-Key','pr6-batch-validation-matrix')
      .attach('file',await makeWorkbook(rows),'batch-validation.xlsx').expect(201);
    expect(imported.body.data).toMatchObject({totalCount:7,successCount:2,failureCount:5});
    expect(imported.body.data.failures.map((row:any)=>row.row)).toEqual([3,4,6,7,8]);
    expect(imported.body.data.failures[0].message).toContain('整数');
    expect(imported.body.data.failures[1].message).toContain('启用了批次管理');
    expect(imported.body.data.failures[2].message).toContain('权限');
    expect(imported.body.data.failures.slice(3).every((row:any)=>row.message.includes('超出系统上限'))).toBe(true);
    expect(imported.body.data.documents).toHaveLength(1);
    const importedDocument=imported.body.data.documents[0];
    const details=(await request(app.getHttpServer()).get(`/api/stock-documents/${importedDocument.id}`).set(auth(admin)).expect(200)).body.data;
    expect(details.lines).toHaveLength(2);
    expect(details.lines.find((line:any)=>line.itemId===ids['M-003']).batchId).toBe(batch.body.data.id);
    await request(app.getHttpServer()).delete(`/api/stock-documents/${importedDocument.id}`).set(auth(warehouse)).expect(200);
    await db.query(`UPDATE items SET enable_batch=false WHERE id=$1`,[ids['M-003']]);

    const tooMany=await makeWorkbook(Array.from({length:1001},()=>['M-001','','','','1','',raw.warehouse,raw.zone,raw.location,'','']));
    await request(app.getHttpServer()).post('/api/stock-documents/material-inbound/batch-import').set(auth(warehouse))
      .set('Idempotency-Key','pr6-batch-row-limit').attach('file',tooMany,'too-many.xlsx').expect(400);

    const [fg]=await db.query(`SELECT w.warehouse_code warehouse,z.code zone,l.code location FROM warehouses w
      JOIN warehouse_zones z ON z.warehouse_id=w.id JOIN warehouse_locations l ON l.zone_id=z.id
      WHERE w.warehouse_type='FG' AND w.status='ACTIVE' AND z.status='ACTIVE' AND l.status='ACTIVE' AND l.is_archived=false
      ORDER BY w.warehouse_code,z.code,l.code LIMIT 1`);
    const finishedFile=await makeWorkbook([['FG-001','成品','监测终端','标准版','1','台',fg.warehouse,fg.zone,fg.location,'成品批量验收','']]);
    const finished=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound/batch-import').set(auth(warehouse))
      .set('Idempotency-Key','pr6-finished-batch-import').attach('file',finishedFile,'finished.xlsx').expect(201);
    expect(finished.body.data).toMatchObject({successCount:1,failureCount:0,documents:[{lineCount:1}]});
    await request(app.getHttpServer()).delete(`/api/stock-documents/${finished.body.data.documents[0].id}`).set(auth(warehouse)).expect(200);
    await db.query(`DELETE FROM warehouse_locations WHERE id=$1`,[unassignedLocation.id]);
    await db.query(`DELETE FROM warehouse_zones WHERE id=$1`,[unassignedZone.id]);
    await db.query(`DELETE FROM warehouses WHERE id=$1`,[unassigned.id]);
  });
  it('逐行审批支持正常品与不良品分配并记录库存流水和审核审计',async()=>{
    process.env.BATCH_INBOUND_ENABLED='true';
    const beforeNormal=await balanceOf('RAW','M-003');
    const beforeDefective=(await balanceOf('DEFECTIVE','M-003')) || '0';
    const draft=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse))
      .send({lines:[{itemId:ids['M-003'],quantity:'2'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    const detail=(await request(app.getHttpServer()).get(`/api/approvals/${draft.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    const [line]=detail.lines;
    const normal=detail.allocationOptions.find((row:any)=>row.warehouseType==='RAW');
    const defective=detail.allocationOptions.find((row:any)=>row.warehouseType==='DEFECTIVE');
    for (const target of [normal,defective]) {
      const [{ quantity }] = await db.query(`SELECT COALESCE(sum(on_hand_qty),0)::text quantity FROM stock_balances WHERE location_id=$1 AND item_id=$2`,[target.locationId,ids['M-003']]);
      await db.query(`INSERT INTO location_item_capacities(location_id,item_id,capacity) VALUES($1,$2,$3)
        ON CONFLICT(location_id,item_id) DO UPDATE SET capacity=EXCLUDED.capacity`,[target.locationId,ids['M-003'],String(Number(quantity)+1)]);
    }
    await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin))
      .set('Idempotency-Key','pr5-line-defective-split').send({
        decisions:[{lineId:line.id,decision:'APPROVE',quantity:'2',locationId:line.locationId}],
        receiptAllocations:[
          {documentLineId:line.id,disposition:'NORMAL',warehouseId:normal.warehouseId,locationId:normal.locationId,quantity:'1'},
          {documentLineId:line.id,disposition:'DEFECTIVE',warehouseId:defective.warehouseId,locationId:defective.locationId,quantity:'1',defectReason:'隔离验收不良品'},
        ],
      }).expect(201);
    expect(await balanceOf('RAW','M-003')).toBe(String(Number(beforeNormal)+1));
    const [lot]=await db.query(`SELECT received_qty,remaining_qty,defect_reason FROM defective_inventory_lots WHERE source_document_id=$1`,[draft.body.data.id]);
    expect(lot).toEqual({received_qty:'1',remaining_qty:'1',defect_reason:'隔离验收不良品'});
    const flows=await db.query(`SELECT delta_qty FROM stock_transactions WHERE source_document_id=$1 ORDER BY delta_qty`,[draft.body.data.id]);
    expect(flows.map((row:any)=>row.delta_qty)).toEqual(['1','1']);
    const capacityHolds=await db.query(`SELECT location_id,status,quantity::numeric(18,0)::text quantity FROM location_capacity_reservations WHERE document_id=$1 AND status='CONSUMED' ORDER BY location_id`,[draft.body.data.id]);
    expect(capacityHolds).toHaveLength(2);
    expect(capacityHolds.every((row:any)=>row.status==='CONSUMED'&&row.quantity==='1')).toBe(true);
    const history=(await request(app.getHttpServer()).get(`/api/approvals/${draft.body.data.id}/history`).set(auth(admin)).expect(200)).body.data;
    expect(history.some((row:any)=>row.action==='APPROVED'&&row.statusAfter==='POSTED')).toBe(true);
    const voided=await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/void`).set(auth(warehouse))
      .set('Idempotency-Key','void1').send({reason:'隔离验收冲销'}).expect(201);
    const voidRetry=await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/void`).set(auth(warehouse))
      .set('Idempotency-Key','void1').send({reason:'隔离验收冲销'}).expect(201);
    expect(voidRetry.body.data).toEqual(voided.body.data);
    expect(await balanceOf('RAW','M-003')).toBe(beforeNormal);
    expect(await balanceOf('DEFECTIVE','M-003')).toBe(beforeDefective);
    const reversalFlows=await db.query(`SELECT warehouse_id,delta_qty FROM stock_transactions WHERE source_document_id=$1 ORDER BY warehouse_id`,[voided.body.data.id]);
    expect(reversalFlows).toHaveLength(2);
    expect(reversalFlows.map((row:any)=>row.delta_qty)).toEqual(['-1','-1']);
    const original=(await request(app.getHttpServer()).get(`/api/stock-documents/${draft.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    expect(original.status).toBe('VOIDED');
    const [resolvedLot]=await db.query(`SELECT remaining_qty,status FROM defective_inventory_lots WHERE source_document_id=$1`,[draft.body.data.id]);
    expect(resolvedLot).toEqual({remaining_qty:'0',status:'RESOLVED'});
  });
  it('逐行驳回不改库存，修改后重新提交可正常过账',async()=>{
    process.env.BATCH_INBOUND_ENABLED='true';
    const before=await balanceOf('RAW','M-001');
    const draft=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse)).send({lines:[{itemId:ids['M-001'],quantity:'1'}]}).expect(201);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    const [line]=((await request(app.getHttpServer()).get(`/api/stock-documents/${draft.body.data.id}`).set(auth(admin)).expect(200)).body.data.lines);
    const rejected=await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin)).set('Idempotency-Key','pr5-line-reject').send({decisions:[{lineId:line.id,decision:'REJECT',reason:'库位待确认'}]}).expect(201);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(await balanceOf('RAW','M-001')).toBe(before);
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/submit`).set(auth(warehouse)).send({}).expect(201);
    const resubmitted=(await request(app.getHttpServer()).get(`/api/stock-documents/${draft.body.data.id}`).set(auth(admin)).expect(200)).body.data;
    expect(resubmitted.lines[0].reviewStatus).toBe('PENDING');
    await request(app.getHttpServer()).post(`/api/approvals/${draft.body.data.id}/approve-lines`).set(auth(admin)).set('Idempotency-Key','pr5-line-resubmit-approve').send({decisions:[{lineId:line.id,decision:'APPROVE',quantity:'1',locationId:line.locationId}]}).expect(201);
    expect(await balanceOf('RAW','M-001')).toBe(String(Number(before)+1));
    await request(app.getHttpServer()).post(`/api/stock-documents/${draft.body.data.id}/void`).set(auth(warehouse)).set('Idempotency-Key','pr5-line-resubmit-cleanup').send({reason:'隔离验收结束后恢复测试基线'}).expect(201);
    expect(await balanceOf('RAW','M-001')).toBe(before);
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
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({warehouseId:ids.outboundSource.warehouseId,lines:[{itemId:ids['M-001'],locationId:ids.outboundSource.locationId,quantity:'5'}]}).expect(400);
    const inactive=await request(app.getHttpServer()).post('/api/items').set(auth(admin)).send({itemCode:'FG-INACTIVE',name:'停用成品',itemType:'FINISHED_GOOD',unit:'台'}).expect(201);
    await request(app.getHttpServer()).patch(`/api/items/${inactive.body.data.id}`).set(auth(admin)).send({status:'INACTIVE'}).expect(200);
    await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({warehouseId:ids.outboundSource.warehouseId,lines:[{itemId:inactive.body.data.id,locationId:ids.outboundSource.locationId,quantity:'1'}]}).expect(400);

    const draft=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({warehouseId:ids.outboundSource.warehouseId,notes:'非生产来源成品',lines:[{itemId:ids['FG-001'],locationId:ids.outboundSource.locationId,quantity:'5'}]}).expect(201);
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

    const conflictDraft=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse)).send({warehouseId:ids.outboundSource.warehouseId,lines:[{itemId:ids['FG-001'],locationId:ids.outboundSource.locationId,quantity:'1'}]}).expect(201);
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
    const created=await Promise.all(Array.from({length:10},()=>request(app.getHttpServer()).post('/api/stock-documents/finished-outbound').set(auth(warehouse)).send({warehouseId:ids.outboundSource.warehouseId,lines:[{itemId:ids['FG-001'],locationId:ids.outboundSource.locationId,quantity:'1'}]})));
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
    expect(version.body.data.version).toBe('1.8.0');

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

  it('管理员重置后的密码在再次运行生产种子后仍保持有效', async () => {
    const users = await request(app.getHttpServer()).get('/api/users?pageSize=100').set(auth(admin)).expect(200);
    const target = users.body.data.items.find((user: any) => user.username === 'production');
    await request(app.getHttpServer()).post(`/api/users/${target.id}/reset-password`).set(auth(admin)).send({ password: 'NewDemo@2026' }).expect(201);
    await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'production', password: 'Demo@123456' }).expect(401);
    await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'production', password: 'NewDemo@2026' }).expect(201);
    await seedDatabase(db, false);
    await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'production', password: 'Demo@123456' }).expect(401);
    await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'production', password: 'NewDemo@2026' }).expect(201);
  });

  it('批量入库在线准备可重复执行且只补齐历史原材料已过账明细',async()=>{
    process.env.BATCH_INBOUND_ENABLED='true';
    await prepareBatchInbound(db,false);
    await prepareBatchInbound(db,false);
    const material=await request(app.getHttpServer()).post('/api/stock-documents/material-inbound').set(auth(warehouse))
      .send({lines:[{itemId:ids['M-001'],quantity:'1'}]}).expect(201);
    await submitApprove(material.body.data.id,'pr6-backfill-material');
    const [fgLocation]=await db.query(`SELECT w.id "warehouseId",l.id "locationId" FROM warehouses w
      JOIN warehouse_locations l ON l.warehouse_id=w.id WHERE w.warehouse_code='FG' AND l.status='ACTIVE' AND l.is_archived=false ORDER BY l.code LIMIT 1`);
    const finished=await request(app.getHttpServer()).post('/api/stock-documents/finished-inbound').set(auth(warehouse))
      .send({warehouseId:fgLocation.warehouseId,
        lines:[{itemId:ids['FG-001'],quantity:'1',locationId:fgLocation.locationId}]}).expect(201);
    await submitApprove(finished.body.data.id,'pr6-backfill-finished');
    const [materialLine]=await db.query(`SELECT id FROM stock_document_lines WHERE document_id=$1`,[material.body.data.id]);
    const [finishedLine]=await db.query(`SELECT id FROM stock_document_lines WHERE document_id=$1`,[finished.body.data.id]);
    await db.query(`UPDATE stock_document_lines SET review_status='PENDING',reviewed_by=NULL,reviewed_at=NULL WHERE id=ANY($1::uuid[])`,[[materialLine.id,finishedLine.id]]);
    await prepareBatchInbound(db,true);
    const states=await db.query(`SELECT id,review_status FROM stock_document_lines WHERE id=ANY($1::uuid[])`,[[materialLine.id,finishedLine.id]]);
    expect(states.find((row:any)=>row.id===materialLine.id).review_status).toBe('POSTED');
    expect(states.find((row:any)=>row.id===finishedLine.id).review_status).toBe('PENDING');
    const [{indisvalid}]=await db.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='ix_stock_document_lines_review'`);
    expect(indisvalid).toBe(true);
  });

  async function balanceOf(warehouseCode:string,itemCode:string){const r=await request(app.getHttpServer()).get('/api/inventory/balances?pageSize=100').set(auth(admin)).expect(200);return r.body.data.items.find((x:any)=>x.warehouseCode===warehouseCode&&x.itemCode===itemCode)?.onHandQty;}
  async function expectBalances(expected:any){for(const[warehouseCode,items]of Object.entries(expected) as any)for(const[itemCode,value]of Object.entries(items) as any)expect(await balanceOf(warehouseCode,itemCode)).toBe(value);}
  async function approvalPayload(documentId:string){const detail=(await request(app.getHttpServer()).get(`/api/stock-documents/${documentId}`).set(auth(warehouse)).expect(200)).body.data;return ['MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_RETURN','PRODUCTION_COMPLETION'].includes(detail.documentType)?{receiptAllocations:detail.lines.map((line:any)=>({documentLineId:line.id,disposition:'NORMAL',warehouseId:detail.warehouseId,locationId:line.locationId,quantity:line.quantity,batchId:line.batchId||undefined}))}:{};}
  async function submitApprove(documentId:string,key:string){await request(app.getHttpServer()).post(`/api/stock-documents/${documentId}/submit`).set(auth(warehouse)).send({}).expect(201);return request(app.getHttpServer()).post(`/api/approvals/${documentId}/approve`).set(auth(admin)).set('Idempotency-Key',key).send(await approvalPayload(documentId)).expect(201);}
});
