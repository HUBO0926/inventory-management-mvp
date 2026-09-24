import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ApprovalHistoryService } from '../audit/approval-history.service';
import { ApprovalWorkflowService } from '../approvals/approval-workflow.service';
import { BusinessException } from '../common/business.exception';
import { AuthUser, Direction, DocumentType, ProductionStatus } from '../common/constants';
import { InventoryPostingService } from '../inventory/posting.service';
import { StockReservationService } from '../inventory/reservation.service';

@Injectable()
export class PickingOrdersService {
  constructor(
    private readonly db: DataSource,
    private readonly posting: InventoryPostingService,
    private readonly reservations: StockReservationService,
    private readonly audit: AuditService,
    private readonly history: ApprovalHistoryService,
    private readonly workflow: ApprovalWorkflowService,
  ) {}

  async shortages(orderId: string, manager: DataSource | QueryRunner = this.db) {
    const rows = await manager.query(
      `WITH reserved AS (
         SELECT item_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY item_id
       ), inventory AS (
         SELECT sb.item_id,sum(GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0),0)) qty
         FROM stock_balances sb
         JOIN warehouses w ON w.id=sb.warehouse_id
         JOIN warehouse_locations l ON l.id=sb.location_id
         WHERE w.warehouse_type='RAW' AND w.status='ACTIVE' AND w.deleted_at IS NULL
           AND l.status='ACTIVE' AND COALESCE(l.is_archived,false)=false
         GROUP BY sb.item_id
       )
       SELECT m.material_id "materialId",i.item_code "itemCode",i.name "itemName",i.model,i.spec,i.unit,
         m.required_qty "requiredQty",m.issued_qty "issuedQty",m.returned_qty "returnedQty",
         (m.issued_qty-m.returned_qty)::numeric(18,0) "netIssuedQty",
         GREATEST(m.required_qty-(m.issued_qty-m.returned_qty),0)::numeric(18,0) "pendingQty",
         GREATEST(COALESCE(inv.qty,0)-COALESCE(r.qty,0),0)::numeric(18,0) "availableQty",
         GREATEST(GREATEST(m.required_qty-(m.issued_qty-m.returned_qty),0)-GREATEST(COALESCE(inv.qty,0)-COALESCE(r.qty,0),0),0)::numeric(18,0) "shortageQty",
         m.spare_issued_qty "spareIssuedQty",
         CASE
           WHEN GREATEST(COALESCE(inv.qty,0)-COALESCE(r.qty,0),0)=0 THEN 'EMPTY'
           WHEN GREATEST(COALESCE(inv.qty,0)-COALESCE(r.qty,0),0)<GREATEST(m.required_qty-(m.issued_qty-m.returned_qty),0) THEN 'PARTIAL'
           ELSE 'SATISFIED'
         END status
       FROM production_order_materials m
       JOIN items i ON i.id=m.material_id
       LEFT JOIN inventory inv ON inv.item_id=m.material_id
       LEFT JOIN reserved r ON r.item_id=m.material_id
       WHERE m.production_order_id=$1 ORDER BY i.item_code`,
      [orderId],
    );
    if (!rows.length) {
      const [order] = await manager.query(`SELECT id FROM production_orders WHERE id=$1`, [orderId]);
      if (!order) throw new BusinessException('NOT_FOUND', '生产任务不存在');
    }
    return rows.map((row: any) => Object.fromEntries(Object.entries(row).map(([key,value]) => [
      key,
      key.endsWith('Qty') ? new Decimal(value as any || 0).toFixed(0) : value,
    ])));
  }

  async checkShortage(orderId: string, user: AuthUser) {
    const rows = await this.shortages(orderId);
    const missing = rows.filter((row: any) => new Decimal(row.shortageQty).gt(0));
    await this.db.query(`UPDATE production_orders SET shortage_flag=$1,shortage_checked_at=now(),shortage_summary=$2,updated_at=now() WHERE id=$3`, [missing.length > 0, JSON.stringify(missing.map((row: any) => ({ materialId:row.materialId,itemCode:row.itemCode,shortageQty:row.shortageQty }))), orderId]);
    await this.audit.log(user.id,'CHECK_PRODUCTION_SHORTAGE','production_orders',orderId,{ shortageCount:missing.length,shortages:missing });
    return { orderId, shortageCount:missing.length, hasShortage:missing.length > 0, items:rows, checkedAt:new Date().toISOString() };
  }

  async createManual(orderId: string, dto: any, key: string | undefined, user: AuthUser) {
    return this.posting.executeIdempotent(user.id,key,'POST:/production-orders/:id/picking-orders/manual',{orderId,...dto},async qr => {
      const order = await this.lockOrder(qr,orderId);
      const shortages = await this.shortages(orderId,qr);
      const normalized = this.validateMaterials(dto.materials,shortages);
      const warehouseId = dto.defaultWarehouseId || order.default_issue_warehouse_id || await this.firstRawWarehouse(qr);
      const lines = normalized.flatMap((material: any) => material.allocations.map((allocation: any) => ({
        itemId:material.materialId,
        quantity:new Decimal(allocation.normalQty || 0).add(allocation.spareQty || 0).toFixed(0),
        normalQty:new Decimal(allocation.normalQty || 0).toFixed(0),
        spareQty:new Decimal(allocation.spareQty || 0).toFixed(0),
        sourceWarehouseId:allocation.warehouseId,
        locationId:allocation.locationId,
        batchId:allocation.batchId,
        direction:Direction.OUT,
      })));
      if (!lines.length) throw new BusinessException('VALIDATION_ERROR','领料单没有可分配库存明细');
      await this.validateAllocationRows(qr,lines);
      const doc = await this.posting.createDocument(qr,{documentType:DocumentType.PRODUCTION_ISSUE,warehouseId,productionOrderId:orderId,notes:dto.notes,lines,...({operator:user} as any)},user.id);
      await qr.query(`UPDATE stock_documents SET issue_mode='MANUAL' WHERE id=$1`,[doc.id]);
      await this.saveSummaries(qr,doc.id,normalized,shortages);
      await this.audit.log(user.id,'CREATE_MANUAL_PICKING','stock_documents',doc.id,{orderId,materials:normalized},qr.manager);
      return this.getWith(qr,doc.id);
    });
  }

  async createAuto(orderId: string, dto: any, key: string | undefined, user: AuthUser) {
    return this.posting.executeIdempotent(user.id,key,'POST:/production-orders/:id/picking-orders/auto-generate',{orderId,...dto},async qr => {
      const order = await this.lockOrder(qr,orderId);
      const shortages = await this.shortages(orderId,qr);
      const preferred = dto.defaultWarehouseId || order.default_issue_warehouse_id || await this.firstRawWarehouse(qr);
      const spares = new Map<string,string>((dto.spares || []).map((row: any) => [row.materialId,String(row.quantity || 0)]));
      const materials = [];
      for (const item of shortages) {
        const spareQty = spares.get(item.materialId) || '0';
        this.validateSpare(item,spareQty);
        const allocation = await this.allocate(qr,item.materialId,item.pendingQty,spareQty,preferred);
        materials.push({materialId:item.materialId,normalQty:item.pendingQty,spareQty,allocations:allocation.lines});
      }
      const lines = materials.flatMap((material: any) => material.allocations.map((allocation: any) => ({
        itemId:material.materialId,quantity:new Decimal(allocation.normalQty).add(allocation.spareQty).toFixed(0),
        normalQty:allocation.normalQty,spareQty:allocation.spareQty,sourceWarehouseId:allocation.warehouseId,
        locationId:allocation.locationId,batchId:allocation.batchId,direction:Direction.OUT,
      })));
      if (!lines.length) throw new BusinessException('INSUFFICIENT_STOCK','当前没有可用于领料的库存',HttpStatus.CONFLICT,{shortages});
      const doc = await this.posting.createDocument(qr,{documentType:DocumentType.PRODUCTION_ISSUE,warehouseId:preferred,productionOrderId:orderId,notes:dto.notes,lines,...({operator:user} as any)},user.id);
      await qr.query(`UPDATE stock_documents SET issue_mode='AUTO' WHERE id=$1`,[doc.id]);
      await this.saveSummaries(qr,doc.id,materials,shortages);
      await this.audit.log(user.id,'CREATE_AUTO_PICKING','stock_documents',doc.id,{orderId,materials},qr.manager);
      return this.getWith(qr,doc.id);
    });
  }

  async get(id: string) { return this.getWith(this.db,id); }

  async update(id: string,dto: any,key: string|undefined,user: AuthUser) {
    return this.posting.executeIdempotent(user.id,key,'PUT:/picking-orders/:id',{id,...dto},async qr => {
      const [doc] = await qr.query(`SELECT * FROM stock_documents WHERE id=$1 FOR UPDATE`,[id]);
      if (!doc || doc.document_type!==DocumentType.PRODUCTION_ISSUE) throw new BusinessException('NOT_FOUND','生产领料单不存在');
      if (!['DRAFT','REJECTED','SUBMITTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS','当前领料单不能编辑');
      if (doc.status==='SUBMITTED') {
        await this.reservations.releaseDocument(qr,id);
        await this.history.record(qr,id,'WITHDRAWN','SUBMITTED','DRAFT',user.id,{reason:'编辑待审核领料单自动撤回'});
      }
      const shortages = await this.shortages(doc.production_order_id,qr);
      const materials = this.validateMaterials(dto.materials,shortages);
      const before = await this.getWith(qr,id);
      await qr.query(`DELETE FROM stock_document_lines WHERE document_id=$1`,[id]);
      await qr.query(`DELETE FROM production_issue_materials WHERE document_id=$1`,[id]);
      for (const material of materials) for (const allocation of material.allocations) {
        const total = new Decimal(allocation.normalQty || 0).add(allocation.spareQty || 0);
        if (!total.gt(0)) continue;
        await this.insertLine(qr,id,material.materialId,allocation,total);
      }
      await this.saveSummaries(qr,id,materials,shortages);
      await qr.query(`UPDATE stock_documents SET status='DRAFT',notes=$1,submitted_by=NULL,submitted_at=NULL,rejection_reason=NULL,updated_at=now() WHERE id=$2`,[dto.notes||null,id]);
      const after = await this.getWith(qr,id);
      await this.audit.log(user.id,'UPDATE_PICKING','stock_documents',id,{before,after},qr.manager);
      return after;
    });
  }

  async autoAllocate(id: string,dto: any,key:string|undefined,user:AuthUser) {
    const current = await this.get(id);
    const materials = current.materials.map((row:any)=>({materialId:row.materialId,quantity:dto.spares?.find((x:any)=>x.materialId===row.materialId)?.quantity ?? row.spareRequestedQty}));
    const generated = await this.previewAllocation(current.productionOrderId,materials,current.defaultWarehouseId);
    return this.update(id,{notes:current.notes,materials:generated.materials},key,user);
  }

  async submit(id:string,key:string|undefined,user:AuthUser) {
    return this.changeState(id,key,user,'submit',async qr => {
      const [doc]=await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`,[id]);
      if (!doc || !['DRAFT','REJECTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS','只有草稿或已驳回领料单可以提交');
      await this.validateDocumentInventory(qr,id);
      await this.reservations.reserveDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='SUBMITTED',submitted_by=$1,submitted_at=now(),updated_at=now() WHERE id=$2`,[user.id,id]);
      await this.workflow.submit(qr, id, user.id, doc.status);
    });
  }

  async withdraw(id:string,key:string|undefined,user:AuthUser) {
    return this.changeState(id,key,user,'withdraw',async qr => {
      const [doc]=await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`,[id]);
      if (!doc || doc.status!=='SUBMITTED') throw new BusinessException('INVALID_STATUS','只有待审核领料单可以撤回');
      await this.reservations.releaseDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='DRAFT',submitted_by=NULL,submitted_at=NULL,updated_at=now() WHERE id=$1`,[id]);
      await this.workflow.closePending(qr, id, 'REVOKED');
      await this.history.record(qr,id,'WITHDRAWN','SUBMITTED','DRAFT',user.id);
    });
  }

  async cancel(id:string,key:string|undefined,user:AuthUser) {
    return this.changeState(id,key,user,'cancel',async qr => {
      const [doc]=await qr.query(`SELECT status FROM stock_documents WHERE id=$1 FOR UPDATE`,[id]);
      if (!doc || !['DRAFT','SUBMITTED','REJECTED'].includes(doc.status)) throw new BusinessException('INVALID_STATUS','当前领料单不能撤销');
      await this.reservations.releaseDocument(qr,id);
      await qr.query(`UPDATE stock_documents SET status='CANCELLED',updated_at=now() WHERE id=$1`,[id]);
      await this.history.record(qr,id,'CANCELLED',doc.status,'CANCELLED',user.id);
    });
  }

  availableLocations(q:any) {
    const params:any[]=[q.itemId];
    const where:string[]=[`sb.item_id=$1`,`w.warehouse_type='RAW'`,`w.status='ACTIVE'`,`w.deleted_at IS NULL`,`l.status='ACTIVE'`,`COALESCE(l.is_archived,false)=false`];
    if(q.warehouseId){params.push(q.warehouseId);where.push(`w.id=$${params.length}`);}
    const requested=new Decimal(q.quantity||0);
    params.push(requested.toFixed(0));
    return this.db.query(`SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",z.id "zoneId",z.code "zoneCode",l.id "locationId",l.code "locationCode",l.code "locationDisplayName",NULLIF(z.actual_location,'未填写') "actualPosition",b.id "batchId",b.batch_no "batchNo",
      GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0)::numeric(18,0)::text "availableQty"
      FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id JOIN warehouse_locations l ON l.id=sb.location_id JOIN warehouse_zones z ON z.id=l.zone_id
      LEFT JOIN inventory_batches b ON b.id=sb.batch_id
      LEFT JOIN (SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id,batch_id) r
        ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
      WHERE ${where.join(' AND ')} AND GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0)>=$${params.length}
      ORDER BY w.warehouse_code,l.code,b.batch_no NULLS FIRST`,params);
  }

  async validateAllocation(dto:any) {
    const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();
    try{await this.validateAllocationRows(qr,dto.lines||[]);await qr.rollbackTransaction();return{valid:true};}
    catch(error){await qr.rollbackTransaction();throw error;}finally{await qr.release();}
  }

  async previewAllocation(orderId:string,spares:any[]=[],preferred?:string) {
    const shortages=await this.shortages(orderId); const warehouseId=preferred||await this.firstRawWarehouse(this.db as any);
    const spareMap=new Map(spares.map((row:any)=>[row.materialId,String(row.quantity||0)])); const materials=[];
    for(const item of shortages){const spareQty=spareMap.get(item.materialId)||'0';this.validateSpare(item,spareQty);const allocated=await this.allocate(this.db as any,item.materialId,item.pendingQty,spareQty,warehouseId);materials.push({materialId:item.materialId,normalQty:item.pendingQty,spareQty,allocations:allocated.lines});}
    return{materials};
  }

  private validateMaterials(materials:any[],shortages:any[]) {
    if(!Array.isArray(materials)||!materials.length)throw new BusinessException('VALIDATION_ERROR','至少选择一种 BOM 物料');
    const map=new Map(shortages.map((row:any)=>[row.materialId,row]));
    return materials.map(material=>{
      const current:any=map.get(material.materialId);if(!current)throw new BusinessException('VALIDATION_ERROR','领料物料不属于任务 BOM');
      const normal=new Decimal(material.normalQty||0),spare=new Decimal(material.spareQty||0);
      if(normal.isNegative()||normal.gt(current.pendingQty))throw new BusinessException('VALIDATION_ERROR',`${current.itemCode} 正常领料不能超过本次待领量`);
      if(!normal.isInteger()||!spare.isInteger())throw new BusinessException('VALIDATION_ERROR',`${current.itemCode} 领料数量必须是整数`);
      this.validateSpare(current,spare.toFixed(0));
      const allocations=(material.allocations||[]).filter((row:any)=>new Decimal(row.normalQty||0).add(row.spareQty||0).gt(0));
      const normalAllocated=allocations.reduce((sum:Decimal,row:any)=>sum.add(row.normalQty||0),new Decimal(0));
      const spareAllocated=allocations.reduce((sum:Decimal,row:any)=>sum.add(row.spareQty||0),new Decimal(0));
      if(normalAllocated.gt(normal)||spareAllocated.gt(spare))throw new BusinessException('VALIDATION_ERROR',`${current.itemCode} 分配数量超过申请数量`);
      return{...material,normalQty:normal.toFixed(0),spareQty:spare.toFixed(0),allocations};
    });
  }

  private validateSpare(item:any,value:string){const spare=new Decimal(value||0);if(!spare.isInteger()||spare.isNegative()||spare.gt(new Decimal(item.requiredQty).mul('0.1').floor()))throw new BusinessException('VALIDATION_ERROR',`${item.itemCode} 备用件必须是整数且不能超过 BOM 需求量的 10%`);}

  private async allocate(db:any,itemId:string,normalQty:string,spareQty:string,preferred:string) {
    const rows=await db.query(`SELECT sb.warehouse_id "warehouseId",w.warehouse_code "warehouseCode",sb.location_id "locationId",l.code "locationCode",l.code "locationDisplayName",NULLIF(z.actual_location,'未填写') "actualPosition",sb.batch_id "batchId",
      GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0)::numeric(18,0) available
      FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id JOIN warehouse_locations l ON l.id=sb.location_id JOIN warehouse_zones z ON z.id=l.zone_id
      LEFT JOIN (SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id,batch_id) r
       ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
      WHERE sb.item_id=$1 AND w.warehouse_type='RAW' AND w.status='ACTIVE' AND w.deleted_at IS NULL AND l.status='ACTIVE' AND COALESCE(l.is_archived,false)=false
      AND GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0)>0`,[itemId]);
    let normal=new Decimal(normalQty),spare=new Decimal(spareQty);
    rows.sort((a:any,b:any)=>Number(b.warehouseId===preferred)-Number(a.warehouseId===preferred)||Number(new Decimal(b.available).gte(normal))-Number(new Decimal(a.available).gte(normal))||a.warehouseCode.localeCompare(b.warehouseCode)||a.locationCode.localeCompare(b.locationCode));
    const lines:any[]=[];
    for(const row of rows){let available=new Decimal(row.available),normalTake=Decimal.min(normal,available);normal=normal.sub(normalTake);available=available.sub(normalTake);const spareTake=Decimal.min(spare,available);spare=spare.sub(spareTake);if(normalTake.add(spareTake).gt(0))lines.push({...row,normalQty:normalTake.toFixed(0),spareQty:spareTake.toFixed(0)});}
    return{lines,normalShortage:normal.toFixed(0),spareShortage:spare.toFixed(0)};
  }

  private async saveSummaries(qr:QueryRunner,documentId:string,materials:any[],shortages:any[]){
    const map=new Map(shortages.map((row:any)=>[row.materialId,row]));
    for(const material of materials){const source:any=map.get(material.materialId);const normalAllocated=material.allocations.reduce((s:Decimal,r:any)=>s.add(r.normalQty||0),new Decimal(0));const spareAllocated=material.allocations.reduce((s:Decimal,r:any)=>s.add(r.spareQty||0),new Decimal(0));await qr.query(`INSERT INTO production_issue_materials(document_id,material_id,required_qty,pending_qty,normal_requested_qty,spare_requested_qty,normal_allocated_qty,spare_allocated_qty,shortage_qty) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[documentId,material.materialId,source.requiredQty,source.pendingQty,material.normalQty,material.spareQty,normalAllocated.toFixed(0),spareAllocated.toFixed(0),Decimal.max(new Decimal(material.normalQty).sub(normalAllocated),0).toFixed(0)]);}
  }

  private async insertLine(qr:QueryRunner,documentId:string,itemId:string,a:any,total:Decimal){const [location]=await qr.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND status='ACTIVE' AND COALESCE(is_archived,false)=false`,[a.locationId,a.warehouseId]);if(!location)throw new BusinessException('VALIDATION_ERROR','领料仓库或库位无效');await qr.query(`INSERT INTO stock_document_lines(id,document_id,item_id,quantity,direction,source_warehouse_id,location_id,batch_id,normal_qty,spare_qty) VALUES(gen_random_uuid(),$1,$2,$3,'OUT',$4,$5,$6,$7,$8)`,[documentId,itemId,total.toFixed(0),a.warehouseId,a.locationId,a.batchId||null,new Decimal(a.normalQty||0).toFixed(0),new Decimal(a.spareQty||0).toFixed(0)]);}
  private async validateAllocationRows(qr:QueryRunner,lines:any[]){const seen=new Set<string>();for(const line of lines){const key=`${line.sourceWarehouseId||line.warehouseId}:${line.locationId}:${line.itemId}:${line.batchId||''}`;if(seen.has(key))throw new BusinessException('VALIDATION_ERROR','同一仓库、库位、物料和批次不能重复分配');seen.add(key);const [row]=await qr.query(`SELECT sb.on_hand_qty,COALESCE(sb.frozen_qty,0) frozen_qty,COALESCE(r.qty,0) reserved FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id JOIN warehouse_locations l ON l.id=sb.location_id LEFT JOIN (SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id,batch_id) r ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id WHERE sb.warehouse_id=$1 AND sb.location_id=$2 AND sb.item_id=$3 AND sb.batch_id IS NOT DISTINCT FROM $4 AND w.warehouse_type='RAW' AND w.status='ACTIVE' AND l.status='ACTIVE' FOR UPDATE OF sb`,[line.sourceWarehouseId||line.warehouseId,line.locationId,line.itemId,line.batchId||null]);const qty=new Decimal(line.quantity||0);const available=new Decimal(row?.on_hand_qty||0).sub(row?.frozen_qty||0).sub(row?.reserved||0);if(!qty.isInteger()||!qty.gt(0)||available.lt(qty))throw new BusinessException('INSUFFICIENT_STOCK','领料分配必须为整数且不能超过库位实时可用库存',HttpStatus.CONFLICT,{locationId:line.locationId,availableQty:available.toFixed(0),requestQty:qty.toFixed(0)});}}
  private async validateDocumentInventory(qr:QueryRunner,id:string){const lines=await qr.query(`SELECT item_id "itemId",quantity,COALESCE(source_warehouse_id,d.warehouse_id) "sourceWarehouseId",location_id "locationId",batch_id "batchId" FROM stock_document_lines l JOIN stock_documents d ON d.id=l.document_id WHERE l.document_id=$1`,[id]);await this.validateAllocationRows(qr,lines);}
  private async lockOrder(qr:QueryRunner,id:string){const [order]=await qr.query(`SELECT * FROM production_orders WHERE id=$1 FOR UPDATE`,[id]);if(!order)throw new BusinessException('NOT_FOUND','生产任务不存在');if(![ProductionStatus.RELEASED,ProductionStatus.IN_PROGRESS].includes(order.status))throw new BusinessException('INVALID_STATUS','任务必须已发布且未完成');return order;}
  private async firstRawWarehouse(db:any){const [row]=await db.query(`SELECT id FROM warehouses WHERE warehouse_type='RAW' AND status='ACTIVE' AND deleted_at IS NULL ORDER BY warehouse_code LIMIT 1`);if(!row)throw new BusinessException('NOT_FOUND','没有启用的原材料仓库');return row.id;}
  private async changeState(id:string,key:string|undefined,user:AuthUser,action:string,work:(qr:QueryRunner)=>Promise<void>){return this.posting.executeIdempotent(user.id,key,`POST:/picking-orders/:id/${action}`,{id},async qr=>{await work(qr);await this.audit.log(user.id,`${action.toUpperCase()}_PICKING`,'stock_documents',id,undefined,qr.manager);return this.getWith(qr,id);});}
  private async getWith(db:any,id:string){const [doc]=await db.query(`SELECT d.id,d.document_no "documentNo",d.production_order_id "productionOrderId",d.status,d.issue_mode "issueMode",d.notes,d.rejection_reason "rejectionReason",d.warehouse_id "defaultWarehouseId",d.created_at "createdAt",d.submitted_at "submittedAt" FROM stock_documents d WHERE d.id=$1 AND d.document_type='PRODUCTION_ISSUE'`,[id]);if(!doc)throw new BusinessException('NOT_FOUND','生产领料单不存在');doc.materials=await db.query(`SELECT p.material_id "materialId",i.item_code "itemCode",i.name "itemName",i.model,i.spec,i.unit,p.required_qty "requiredQty",p.pending_qty "pendingQty",p.normal_requested_qty "normalQty",p.spare_requested_qty "spareQty",p.normal_allocated_qty "normalAllocatedQty",p.spare_allocated_qty "spareAllocatedQty",p.shortage_qty "shortageQty" FROM production_issue_materials p JOIN items i ON i.id=p.material_id WHERE p.document_id=$1 ORDER BY i.item_code`,[id]);doc.allocations=await db.query(`SELECT l.id,l.item_id "materialId",COALESCE(l.source_warehouse_id,d.warehouse_id) "warehouseId",w.warehouse_code "warehouseCode",z.id "zoneId",z.code "zoneCode",l.location_id "locationId",loc.code "locationCode",loc.code "locationDisplayName",NULLIF(z.actual_location,'未填写') "actualPosition",l.batch_id "batchId",b.batch_no "batchNo",l.normal_qty "normalQty",l.spare_qty "spareQty",l.quantity FROM stock_document_lines l JOIN stock_documents d ON d.id=l.document_id JOIN warehouses w ON w.id=COALESCE(l.source_warehouse_id,d.warehouse_id) JOIN warehouse_locations loc ON loc.id=l.location_id JOIN warehouse_zones z ON z.id=loc.zone_id LEFT JOIN inventory_batches b ON b.id=l.batch_id WHERE l.document_id=$1 ORDER BY w.warehouse_code,loc.code`,[id]);return doc;}
}
