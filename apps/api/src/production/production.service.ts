import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ApprovalHistoryService } from '../audit/approval-history.service';
import { BusinessException } from '../common/business.exception';
import { BusinessNumberService } from '../common/business-number.service';
import { Direction, DocumentType, ProductionStatus } from '../common/constants';
import { parsePage } from '../common/validation';
import { InventoryPostingService } from '../inventory/posting.service';
import { StockReservationService } from '../inventory/reservation.service';
import { PickingOrdersService } from './picking-orders.service';

@Injectable()
export class ProductionService{
  constructor(private readonly db:DataSource,private readonly posting:InventoryPostingService,private readonly audit:AuditService,private readonly approvalHistory:ApprovalHistoryService,private readonly picking:PickingOrdersService,private readonly reservations:StockReservationService,private readonly numbers:BusinessNumberService){}
  async create(dto:any,userId:string){const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();try{const [output]=await qr.query(`SELECT id FROM items WHERE id=$1 AND item_type IN ('SEMI_FINISHED','FINISHED_GOOD') AND status='ACTIVE' AND deleted_at IS NULL`,[dto.finishedGoodId]);if(!output)throw new BusinessException('VALIDATION_ERROR','产出物料必须是启用的半成品或成品');if(dto.defaultIssueWarehouseId){const [warehouse]=await qr.query(`SELECT id FROM warehouses WHERE id=$1 AND warehouse_type='RAW' AND status='ACTIVE' AND deleted_at IS NULL`,[dto.defaultIssueWarehouseId]);if(!warehouse)throw new BusinessException('VALIDATION_ERROR','默认领料仓库必须是启用的原材料仓库');}const [bom]=await qr.query(`SELECT id FROM boms WHERE finished_good_id=$1 AND status='ACTIVE' AND deleted_at IS NULL`,[dto.finishedGoodId]);if(!bom)throw new BusinessException('VALIDATION_ERROR','产出物料没有启用 BOM');const lines=await qr.query(`SELECT material_id,qty_per FROM bom_items WHERE bom_id=$1 ORDER BY material_id`,[bom.id]);if(!lines.length)throw new BusinessException('VALIDATION_ERROR','BOM 没有组成物料明细');const id=randomUUID(),orderNo=await this.insertProductionOrderHeader(qr,id,dto,userId);for(const l of lines){const required=new Decimal(l.qty_per).mul(dto.plannedQty).toFixed(4);await qr.query(`INSERT INTO production_order_materials(id,production_order_id,material_id,qty_per,required_qty) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),id,l.material_id,l.qty_per,required]);}await this.audit.log(userId,'CREATE_PRODUCTION_ORDER','production_orders',id,{orderNo},qr.manager);await qr.commitTransaction();return this.get(id);}catch(e){await qr.rollbackTransaction();throw e;}finally{await qr.release();}}
  private async insertProductionOrderHeader(qr:QueryRunner,id:string,dto:any,userId:string){
    for(let attempt=0;attempt<2;attempt+=1){
      const orderNo=await this.numbers.productionOrder(qr);
      await qr.query('SAVEPOINT business_number_insert');
      try{
        await qr.query(`INSERT INTO production_orders(id,order_no,finished_good_id,planned_qty,default_issue_warehouse_id,planned_date,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,orderNo,dto.finishedGoodId,dto.plannedQty,dto.defaultIssueWarehouseId||null,dto.plannedDate||null,dto.notes||null,userId]);
        await qr.query('RELEASE SAVEPOINT business_number_insert');
        return orderNo;
      }catch(error:any){
        await qr.query('ROLLBACK TO SAVEPOINT business_number_insert');
        await qr.query('RELEASE SAVEPOINT business_number_insert');
        if(error?.code!=='23505'||attempt===1)throw error;
      }
    }
    throw new Error('生产任务编号生成失败');
  }
  async update(id:string,dto:any,userId:string){const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();try{const [order]=await qr.query(`SELECT * FROM production_orders WHERE id=$1 FOR UPDATE`,[id]);if(!order)throw new BusinessException('NOT_FOUND','生产任务不存在');if(order.status!==ProductionStatus.DRAFT)throw new BusinessException('INVALID_STATUS','只有草稿任务可以编辑');if(dto.defaultIssueWarehouseId){const [warehouse]=await qr.query(`SELECT id FROM warehouses WHERE id=$1 AND warehouse_type='RAW' AND status='ACTIVE' AND deleted_at IS NULL`,[dto.defaultIssueWarehouseId]);if(!warehouse)throw new BusinessException('VALIDATION_ERROR','默认领料仓库必须是启用的原材料仓库');}const qty=dto.plannedQty||order.planned_qty;await qr.query(`UPDATE production_orders SET planned_qty=$1,default_issue_warehouse_id=$2,planned_date=$3,notes=$4,updated_at=now() WHERE id=$5`,[qty,dto.defaultIssueWarehouseId??order.default_issue_warehouse_id,dto.plannedDate??order.planned_date,dto.notes??order.notes,id]);await qr.query(`UPDATE production_order_materials SET required_qty=qty_per*$1 WHERE production_order_id=$2`,[qty,id]);const shortages=await this.picking.shortages(id,qr);await qr.query(`UPDATE production_orders SET shortage_flag=$1,shortage_checked_at=now(),shortage_summary=$2 WHERE id=$3`,[shortages.some((row:any)=>new Decimal(row.shortageQty).gt(0)),JSON.stringify(shortages.filter((row:any)=>new Decimal(row.shortageQty).gt(0))),id]);await this.audit.log(userId,'UPDATE_PRODUCTION_ORDER','production_orders',id,dto,qr.manager);await qr.commitTransaction();return this.get(id);}catch(e){await qr.rollbackTransaction();throw e;}finally{await qr.release();}}
  shortages(id:string,manager?:any){return this.picking.shortages(id,manager||this.db);}
  async release(id:string,userId:string){const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();try{const [order]=await qr.query(`SELECT status FROM production_orders WHERE id=$1 FOR UPDATE`,[id]);if(!order)throw new BusinessException('NOT_FOUND','生产任务不存在');if(order.status!==ProductionStatus.DRAFT)throw new BusinessException('INVALID_STATUS','只有草稿任务可以发布');const shortages=await this.picking.shortages(id,qr);const missing=shortages.filter((row:any)=>new Decimal(row.shortageQty).gt(0));await qr.query(`UPDATE production_orders SET status='RELEASED',shortage_flag=$1,shortage_checked_at=now(),shortage_summary=$2,released_at=now(),updated_at=now() WHERE id=$3`,[missing.length>0,JSON.stringify(missing),id]);await this.audit.log(userId,'RELEASE_PRODUCTION_ORDER','production_orders',id,{shortageCount:missing.length},qr.manager);await qr.commitTransaction();return this.get(id);}catch(e:any){await qr.rollbackTransaction();throw e;}finally{await qr.release();}}
  issue(id:string,dto:any,key:string|undefined,userId:string){return this.posting.executeIdempotent(userId,key,'POST:/production-orders/:id/issue',{id,...dto},async qr=>{await this.lockActionable(qr,id);this.uniqueLines(dto.lines);const mats=await this.materialMap(qr,id);for(const l of dto.lines){const m=mats.get(l.materialId);if(!m)throw new BusinessException('VALIDATION_ERROR','领料物料不属于任务 BOM');const after=new Decimal(m.issued_qty).sub(m.returned_qty).add(l.quantity);if(after.gt(new Decimal(m.required_qty).mul('1.1')))throw new BusinessException('VALIDATION_ERROR',`${m.item_code} 累计净领料不能超过需求量 110%`);}const warehouse=await this.warehouse(qr,'RAW',dto.warehouseId);const doc=await this.posting.createDocument(qr,{documentType:DocumentType.PRODUCTION_ISSUE,warehouseId:warehouse.id,productionOrderId:id,notes:dto.notes,lines:dto.lines.map((l:any)=>({itemId:l.materialId,quantity:l.quantity,locationId:l.locationId,batchId:l.batchId,direction:Direction.OUT}))},userId);await this.markSubmitted(qr,doc.id,userId);return{...doc,status:'SUBMITTED'};});}
  returnMaterial(id:string,dto:any,key:string|undefined,userId:string){return this.posting.executeIdempotent(userId,key,'POST:/production-orders/:id/return',{id,...dto},async qr=>{await this.lockActionable(qr,id);this.uniqueLines(dto.lines);const mats=await this.materialMap(qr,id);for(const l of dto.lines){const m=mats.get(l.materialId);if(!m)throw new BusinessException('VALIDATION_ERROR','退料物料不属于任务 BOM');if(new Decimal(l.quantity).gt(new Decimal(m.issued_qty).sub(m.returned_qty)))throw new BusinessException('VALIDATION_ERROR',`${m.item_code} 退料量超过当前净领料量`);}const warehouse=await this.warehouse(qr,'RAW',dto.warehouseId);const doc=await this.posting.createDocument(qr,{documentType:DocumentType.PRODUCTION_RETURN,warehouseId:warehouse.id,productionOrderId:id,notes:dto.notes,lines:dto.lines.map((l:any)=>({itemId:l.materialId,quantity:l.quantity,locationId:l.locationId,batchId:l.batchId,direction:Direction.IN}))},userId);await this.markSubmitted(qr,doc.id,userId);return{...doc,status:'SUBMITTED'};});}
  complete(id:string,dto:any,key:string|undefined,userId:string){return this.posting.executeIdempotent(userId,key,'POST:/production-orders/:id/complete',{id,...dto},async qr=>{const order=await this.lockActionable(qr,id);const after=new Decimal(order.completed_qty).add(dto.quantity);if(after.gt(order.planned_qty))throw new BusinessException('VALIDATION_ERROR',`累计完工不能超过计划数量 ${order.planned_qty}`);const targetWarehouseType=order.item_type==='SEMI_FINISHED'?'RAW':'FG';const warehouse=await this.warehouse(qr,targetWarehouseType,dto.warehouseId);const doc=await this.posting.createDocument(qr,{documentType:DocumentType.PRODUCTION_COMPLETION,warehouseId:warehouse.id,productionOrderId:id,notes:dto.notes,lines:[{itemId:order.finished_good_id,quantity:dto.quantity,locationId:dto.locationId,batchId:dto.batchId,direction:Direction.IN}]},userId);await this.markSubmitted(qr,doc.id,userId);return{...doc,status:'SUBMITTED'};});}
  async cancel(id:string,reason:string|undefined,userId:string){const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();try{const [order]=await qr.query(`SELECT status FROM production_orders WHERE id=$1 FOR UPDATE`,[id]);if(!order)throw new BusinessException('NOT_FOUND','生产任务不存在');if(![ProductionStatus.DRAFT,ProductionStatus.RELEASED,ProductionStatus.IN_PROGRESS].includes(order.status))throw new BusinessException('INVALID_STATUS','当前状态不能取消');const materials=await qr.query(`SELECT issued_qty,returned_qty FROM production_order_materials WHERE production_order_id=$1`,[id]);if(materials.some((m:any)=>!new Decimal(m.issued_qty).sub(m.returned_qty).isZero()))throw new BusinessException('INVALID_STATUS','存在未退净领料，必须先全部退料');await qr.query(`UPDATE production_orders SET status='CANCELLED',notes=CASE WHEN $1::text IS NULL THEN notes ELSE concat_ws(E'\n',notes,$1) END,updated_at=now() WHERE id=$2`,[reason||null,id]);await this.audit.log(userId,'CANCEL_PRODUCTION_ORDER','production_orders',id,{reason},qr.manager);await qr.commitTransaction();return this.get(id);}catch(e){await qr.rollbackTransaction();throw e;}finally{await qr.release();}}
  private async lockActionable(qr:QueryRunner,id:string){const [order]=await qr.query(`SELECT o.*,i.item_type FROM production_orders o JOIN items i ON i.id=o.finished_good_id WHERE o.id=$1 FOR UPDATE OF o`,[id]);if(!order)throw new BusinessException('NOT_FOUND','生产任务不存在');if(![ProductionStatus.RELEASED,ProductionStatus.IN_PROGRESS].includes(order.status))throw new BusinessException('INVALID_STATUS','任务必须已发布且未完成');return order;}
  private async materialMap(qr:QueryRunner,id:string){const rows:any[]=await qr.query(`SELECT m.*,i.item_code FROM production_order_materials m JOIN items i ON i.id=m.material_id WHERE production_order_id=$1 ORDER BY material_id FOR UPDATE OF m`,[id]);return new Map<string,any>(rows.map((r:any)=>[r.material_id,r]));}
  private async warehouse(qr:QueryRunner,type:string,id?:string){const [w]=id?await qr.query(`SELECT id FROM warehouses WHERE id=$1 AND warehouse_type=$2 AND status='ACTIVE' AND deleted_at IS NULL`,[id,type]):await qr.query(`SELECT id FROM warehouses WHERE warehouse_type=$1 AND status='ACTIVE' AND deleted_at IS NULL ORDER BY warehouse_code LIMIT 1`,[type]);if(!w)throw new BusinessException('NOT_FOUND',`${type} 类型仓库不存在或已停用`);return w;}
  private uniqueLines(lines:any[]){if(new Set(lines.map(l=>l.materialId)).size!==lines.length)throw new BusinessException('VALIDATION_ERROR','同一物料不能重复');}
  private async markSubmitted(qr:QueryRunner,documentId:string,userId:string){await this.reservations.reserveDocument(qr,documentId);await qr.query(`UPDATE stock_documents SET status='SUBMITTED',submitted_by=$1,submitted_at=now(),updated_at=now() WHERE id=$2`,[userId,documentId]);await this.approvalHistory.record(qr,documentId,'SUBMITTED','DRAFT','SUBMITTED',userId);}
  async get(id:string){const [order]=await this.db.query(`SELECT o.id,o.order_no "orderNo",o.finished_good_id "finishedGoodId",i.item_code "finishedGoodCode",i.name "finishedGoodName",i.item_type "outputItemType",i.unit,o.planned_qty "plannedQty",o.completed_qty "completedQty",o.default_issue_warehouse_id "defaultIssueWarehouseId",o.status,o.shortage_flag "shortageFlag",o.shortage_checked_at "shortageCheckedAt",o.planned_date "plannedDate",o.notes,o.created_at "createdAt",o.released_at "releasedAt" FROM production_orders o JOIN items i ON i.id=o.finished_good_id WHERE o.id=$1`,[id]);if(!order)throw new BusinessException('NOT_FOUND','生产任务不存在');order.materials=await this.picking.shortages(id);order.documents=await this.db.query(`SELECT id,document_no "documentNo",document_type "documentType",status,issue_mode "issueMode",rejection_reason "rejectionReason",created_at "createdAt",submitted_at "submittedAt",posted_at "postedAt" FROM stock_documents WHERE production_order_id=$1 ORDER BY created_at DESC`,[id]);return order;}
  async list(q:any){
    const page=parsePage(q.page,1),pageSize=parsePage(q.pageSize,20,100),offset=(page-1)*pageSize;
    const p:any[]=[];const filters:string[]=[];
    if(q.keyword){p.push(`%${q.keyword}%`);filters.push(`(o.order_no ILIKE $${p.length} OR output.item_code ILIKE $${p.length} OR output.name ILIKE $${p.length})`);}
    if(q.dateFrom){p.push(q.dateFrom);filters.push(`o.created_at >= $${p.length}::date`);}
    if(q.dateTo){p.push(q.dateTo);filters.push(`o.created_at < ($${p.length}::date + interval '1 day')`);}
    const clause=filters.length?`WHERE ${filters.join(' AND ')}`:'';
    const rows=await this.db.query(`
      WITH reserved AS (
        SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty
        FROM stock_reservations WHERE status='ACTIVE'
        GROUP BY warehouse_id,location_id,item_id,batch_id
      ), available AS (
        SELECT sb.item_id,sum(GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0)) qty
        FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id
        LEFT JOIN reserved r ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id
          AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
        WHERE w.warehouse_type='RAW' AND w.status='ACTIVE' AND w.deleted_at IS NULL
        GROUP BY sb.item_id
      ), materials AS (
        SELECT pm.production_order_id,
          count(*) FILTER(WHERE GREATEST(pm.required_qty-(pm.issued_qty-pm.returned_qty),0)>COALESCE(a.qty,0))::int "shortageMaterialCount",
          COALESCE(sum(GREATEST(pm.required_qty-(pm.issued_qty-pm.returned_qty),0)),0)::numeric(18,4) "pendingIssueQty",
          COALESCE(sum(GREATEST(pm.spare_issued_qty-pm.spare_returned_qty,0)),0)::numeric(18,4) "pendingReturnQty"
        FROM production_order_materials pm LEFT JOIN available a ON a.item_id=pm.material_id
        GROUP BY pm.production_order_id
      ), pending_docs AS (
        SELECT production_order_id,count(*)::int count
        FROM stock_documents WHERE status='SUBMITTED' AND production_order_id IS NOT NULL
        GROUP BY production_order_id
      )
      SELECT o.id,o.order_no "orderNo",output.item_code "finishedGoodCode",output.name "finishedGoodName",
        output.item_type "outputItemType",o.planned_qty "plannedQty",o.completed_qty "completedQty",o.status,
        COALESCE(m."shortageMaterialCount",0) "shortageMaterialCount",
        COALESCE(m."pendingIssueQty",0)::text "pendingIssueQty",
        CASE WHEN o.status='COMPLETED' THEN COALESCE(m."pendingReturnQty",0) ELSE 0 END::text "pendingReturnQty",
        COALESCE(pd.count,0) "pendingApprovalCount",
        CASE WHEN o.status IN ('IN_PROGRESS','AWAITING_COMPLETION') THEN GREATEST(o.planned_qty-o.completed_qty,0) ELSE 0 END::text "pendingCompletionQty",
        o.planned_date "plannedDate",o.created_at "createdAt"
      FROM production_orders o JOIN items output ON output.id=o.finished_good_id
      LEFT JOIN materials m ON m.production_order_id=o.id
      LEFT JOIN pending_docs pd ON pd.production_order_id=o.id
      ${clause} ORDER BY o.created_at DESC`,p);
    const enriched=rows.map((row:any)=>{
      const todoTypes:string[]=[];
      if(Number(row.pendingApprovalCount)>0)todoTypes.push('PENDING_APPROVAL');
      if(['RELEASED','AWAITING_ISSUE'].includes(row.status))todoTypes.push('PENDING_PRODUCTION');
      if(Number(row.shortageMaterialCount)>0)todoTypes.push('SHORTAGE');
      if(Number(row.pendingIssueQty)>0&&!['DRAFT','COMPLETED','CANCELLED','CLOSED'].includes(row.status))todoTypes.push('PENDING_ISSUE');
      if(Number(row.pendingReturnQty)>0)todoTypes.push('PENDING_RETURN');
      if(Number(row.pendingCompletionQty)>0)todoTypes.push('PENDING_COMPLETION');
      return {...row,todoTypes};
    });
    const matches=(row:any)=>{
      const status=String(q.status||'all');
      if(status==='all'||!status)return true;
      if(status==='pending')return row.todoTypes.length>0;
      if(status==='pending-approval')return row.pendingApprovalCount>0;
      if(status==='pending-production')return row.todoTypes.includes('PENDING_PRODUCTION');
      if(status==='shortage')return row.shortageMaterialCount>0;
      if(status==='pending-issue')return row.todoTypes.includes('PENDING_ISSUE');
      if(status==='in-progress')return row.status==='IN_PROGRESS';
      if(status==='pending-completion')return row.todoTypes.includes('PENDING_COMPLETION');
      if(status==='completed')return row.status==='COMPLETED';
      return row.status===status;
    };
    const selected=enriched.filter(matches);
    const statistics={
      all:enriched.length,
      pendingApproval:enriched.filter((row:any)=>row.pendingApprovalCount>0).length,
      pendingProduction:enriched.filter((row:any)=>row.todoTypes.includes('PENDING_PRODUCTION')).length,
      shortage:enriched.filter((row:any)=>row.shortageMaterialCount>0).length,
      pendingIssue:enriched.filter((row:any)=>row.todoTypes.includes('PENDING_ISSUE')).length,
      inProgress:enriched.filter((row:any)=>row.status==='IN_PROGRESS').length,
      pendingCompletion:enriched.filter((row:any)=>row.todoTypes.includes('PENDING_COMPLETION')).length,
      completed:enriched.filter((row:any)=>row.status==='COMPLETED').length,
    };
    return {items:selected.slice(offset,offset+pageSize),total:selected.length,page,pageSize,statistics};
  }
}
