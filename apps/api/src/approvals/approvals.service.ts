import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { AuthUser, Direction, DocumentType, Role } from '../common/constants';
import { BusinessException } from '../common/business.exception';
import { parsePage } from '../common/validation';
import { snapshotUser } from '../common/snapshot';
import { StockDocumentsService } from '../stock-documents/stock-documents.service';
import { ApprovalHistoryService } from '../audit/approval-history.service';
import { InventoryPostingService } from '../inventory/posting.service';

type Scope = { document_type?: string | null; warehouse_id?: string | null; allow_self_approval: boolean };

@Injectable()
export class ApprovalsService {
  constructor(private readonly db: DataSource, private readonly stock: StockDocumentsService, private readonly approvalHistory: ApprovalHistoryService, private readonly posting: InventoryPostingService) {}

  private async scopes(user: AuthUser): Promise<Scope[]> {
    if (user.role === Role.ADMIN) return [{ allow_self_approval:true }];
    if (!user.roleId) return user.role === Role.WAREHOUSE ? [{ allow_self_approval:false }] : [];
    return this.db.query(`SELECT document_type,warehouse_id,allow_self_approval FROM role_approval_scopes WHERE role_id=$1`,[user.roleId]);
  }
  private scopeMatch(doc:any, scopes:Scope[]) { return scopes.some(s => (!s.document_type || s.document_type===doc.document_type) && (!s.warehouse_id || s.warehouse_id===doc.warehouse_id)); }
  private async requireAction(id:string,user:AuthUser, action:'approve'|'reject') {
    const [doc] = await this.db.query(`SELECT id,document_type,warehouse_id,created_by,status FROM stock_documents WHERE id=$1`,[id]);
    if (!doc) throw new BusinessException('NOT_FOUND','审核单据不存在');
    if (doc.status !== 'SUBMITTED') throw new BusinessException('INVALID_STATUS','只有待审核单据可以处理');
    const scopes=await this.scopes(user); if (!this.scopeMatch(doc,scopes)) throw new BusinessException('FORBIDDEN','当前角色没有该单据的审核范围',HttpStatus.FORBIDDEN);
    if (doc.created_by===user.id && !scopes.some(s => (!s.document_type||s.document_type===doc.document_type)&&(!s.warehouse_id||s.warehouse_id===doc.warehouse_id)&&s.allow_self_approval)) throw new BusinessException('FORBIDDEN','不能审核自己提交的单据',HttpStatus.FORBIDDEN);
    return doc;
  }
  private async viewWhere(user:AuthUser, params:any[], alias='d') {
    const own = user.role !== Role.ADMIN && !user.permissions?.includes('approval.view-all');
    if (own) { params.push(user.id); return `${alias}.created_by=$${params.length}`; }
    const scopes=await this.scopes(user); if (user.role===Role.ADMIN) return 'TRUE'; if (!scopes.length) return 'FALSE';
    const checks:string[]=[]; for (const s of scopes) { const p:string[]=[]; if(s.document_type){params.push(s.document_type);p.push(`${alias}.document_type=$${params.length}`)} if(s.warehouse_id){params.push(s.warehouse_id);p.push(`${alias}.warehouse_id=$${params.length}`)} checks.push(p.length?p.join(' AND '):'TRUE'); } return `(${checks.join(' OR ')})`;
  }
  async statistics(user:AuthUser) {
    const p:any[]=[]; const visible=await this.viewWhere(user,p); const base=`FROM stock_documents d WHERE ${visible}`;
    const userParam=(()=>{p.push(user.id);return `$${p.length}`})();
    const canSelf = (await this.scopes(user)).some(s=>s.allow_self_approval);
    const [row]=await this.db.query(`SELECT
      count(*) FILTER (WHERE d.status='SUBMITTED' ${canSelf?'':`AND d.created_by<>${userParam}`})::int "pendingMine",
      count(*) FILTER (WHERE d.status='SUBMITTED')::int "pendingAll",
      count(*) FILTER (WHERE d.approved_by=${userParam} AND d.approved_at>=date_trunc('day',now()))::int "approvedToday",
      count(*) FILTER (WHERE d.rejected_by=${userParam} AND d.rejected_at>=date_trunc('day',now()))::int "rejectedToday",
      count(*) FILTER (WHERE d.status='SUBMITTED' AND d.submitted_at<now()-interval '24 hours')::int "overdue",
      count(*) FILTER (WHERE d.approved_by=${userParam} AND d.approved_at>=date_trunc('month',now()))::int "approvedMonth"
      ${base}`,p);
    return row || { pendingMine:0,pendingAll:0,approvedToday:0,rejectedToday:0,overdue:0,approvedMonth:0 };
  }
  async list(query:any,user:AuthUser) {
    const page=parsePage(query.page,1),pageSize=parsePage(query.pageSize,20,100),params:any[]=[]; const where=[await this.viewWhere(user,params)];
    const add=(sql:string,v:any)=>{params.push(v);where.push(sql.replace('$?',`$${params.length}`));};
    const tab=query.tab||'pendingMine';
    const canSelf=(await this.scopes(user)).some(s=>s.allow_self_approval);
    if(tab==='pendingMine'){ add(`d.status=$?`,'SUBMITTED'); if(!canSelf) add(`d.created_by<>$?`,user.id); }
    else if(tab==='pendingAll') add(`d.status=$?`,'SUBMITTED');
    else if(tab==='submitted') add(`d.created_by=$?`,user.id);
    else if(tab==='approved') { add(`d.approved_by=$?`,user.id); where.push(`d.status IN ('POSTED','VOIDED')`); }
    else if(tab==='rejected') add(`d.status=$?`,'REJECTED');
    if(query.status) add(`d.status=$?`,query.status); if(query.documentType) add(`d.document_type=$?`,query.documentType); if(query.warehouseId) add(`d.warehouse_id=$?`,query.warehouseId);
    if(query.keyword){params.push(`%${query.keyword}%`);where.push(`(d.document_no ILIKE $${params.length} OR EXISTS(SELECT 1 FROM stock_document_lines sl JOIN items i ON i.id=sl.item_id WHERE sl.document_id=d.id AND (i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length})))`);}
    if(query.overdue==='true') where.push(`d.status='SUBMITTED' AND d.submitted_at<now()-interval '24 hours'`);
    const clause=`WHERE ${where.filter(Boolean).join(' AND ')}`; const [{count}]=await this.db.query(`SELECT count(*)::int count FROM stock_documents d ${clause}`,params);
    params.push(pageSize,(page-1)*pageSize); const items=await this.db.query(`SELECT d.id,d.document_no "documentNo",d.document_type "documentType",d.status,d.notes,w.warehouse_code "warehouseCode",w.name "warehouseName",COALESCE(d.submitted_by_name,u.name,u.username) "submitterName",d.created_by "createdById",COALESCE(d.approved_by_name,au.name,au.username) "approverName",d.submitted_at "submittedAt",d.approved_at "approvedAt",d.rejected_at "rejectedAt",d.rejection_reason "rejectionReason",count(l.id)::int "lineCount",floor(extract(epoch FROM (now()-d.submitted_at))/60)::int "waitingMinutes" FROM stock_documents d JOIN warehouses w ON w.id=d.warehouse_id LEFT JOIN users u ON u.id=d.created_by LEFT JOIN users au ON au.id=d.approved_by LEFT JOIN stock_document_lines l ON l.document_id=d.id ${clause} GROUP BY d.id,w.warehouse_code,w.name,u.name,u.username,au.name,au.username ORDER BY COALESCE(d.submitted_at,d.created_at) DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
    return {items,total:count,page,pageSize};
  }
  async detail(id:string,user:AuthUser) {
    const p:any[]=[]; const visible=await this.viewWhere(user,p); p.push(id);
    const [doc]=await this.db.query(`SELECT d.id FROM stock_documents d WHERE ${visible} AND d.id=$${p.length}` ,p);
    if(!doc) throw new BusinessException('FORBIDDEN','无权查看该审核记录',HttpStatus.FORBIDDEN);
    const detail=await this.stock.get(id);
    if (['MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_RETURN','PRODUCTION_COMPLETION'].includes(detail.documentType)) {
      detail.allocationOptions=await this.db.query(`SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",w.warehouse_type "warehouseType",
        z.id "zoneId",z.code "zoneCode",z.name "zoneName",l.id "locationId",l.code "locationCode",l.name "locationName"
        FROM warehouses w JOIN warehouse_zones z ON z.warehouse_id=w.id JOIN warehouse_locations l ON l.zone_id=z.id
        WHERE w.status='ACTIVE' AND w.deleted_at IS NULL AND z.status='ACTIVE' AND z.deleted_at IS NULL
          AND l.status='ACTIVE' AND l.is_archived=false
        ORDER BY w.warehouse_code,z.code,l.code`);
    }
    return detail;
  }
  async history(id:string,user:AuthUser) { await this.detail(id,user); return this.db.query(`SELECT id,action,status_before "statusBefore",status_after "statusAfter",actor_username "actorUsername",actor_name "actorName",reason_code "reasonCode",reason,request_id "requestId",ip,source,created_at "createdAt" FROM approval_records WHERE document_id=$1 ORDER BY created_at DESC`,[id]); }
  private async completedRetry(userId:string,key:string|undefined,endpoint:string) {
    if(!key?.trim())return false;
    const [row]=await this.db.query(`SELECT 1 FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 AND endpoint=$3 AND response_payload IS NOT NULL`,[userId,key,endpoint]);
    return Boolean(row);
  }
  async approve(id:string,dto:any,key:string|undefined,user:AuthUser, context:any={}) {
    if(!await this.completedRetry(user.id,key,'POST:/approvals/:id/approve'))await this.requireAction(id,user,'approve');
    return this.stock.approve(id,dto,key,user.id,{...context,idempotencyKey:key});
  }
  async reject(id:string,dto:any,key:string|undefined,user:AuthUser, context:any={}) {
    if(!await this.completedRetry(user.id,key,'POST:/approvals/:id/reject'))await this.requireAction(id,user,'reject');
    return this.stock.reject(id,dto.reason,user.id,{...context,idempotencyKey:key,reasonCode:dto.reasonCode});
  }
  async batchReject(ids:string[],reason:string,key:string|undefined,user:AuthUser,context:any={}) {
    if (!ids?.length || !reason?.trim()) throw new BusinessException('VALIDATION_ERROR','请选择单据并填写统一驳回原因');
    return this.posting.executeIdempotent(user.id,key,'POST:/approvals/batch-reject',{ids:[...ids].sort(),reason},async qr=>{
      const docs=await qr.query(`SELECT id,document_type,warehouse_id,created_by,status FROM stock_documents WHERE id=ANY($1::uuid[]) FOR UPDATE`,[ids]); if(docs.length!==ids.length) throw new BusinessException('NOT_FOUND','存在不存在的审核单据'); const scopes=await this.scopes(user);
      for(const doc of docs){if(doc.status!=='SUBMITTED')throw new BusinessException('INVALID_STATUS','批量驳回包含非待审核单据');if(!this.scopeMatch(doc,scopes)||(doc.created_by===user.id&&!scopes.some(s=>(!s.document_type||s.document_type===doc.document_type)&&(!s.warehouse_id||s.warehouse_id===doc.warehouse_id)&&s.allow_self_approval)))throw new BusinessException('FORBIDDEN','批量驳回包含无权限单据',HttpStatus.FORBIDDEN);}
      for(const doc of docs){await qr.query(`UPDATE stock_documents SET status='REJECTED',rejected_by=$1,rejected_by_user_id=$1,
        rejected_by_username=$2,rejected_by_name=$3,rejected_at=now(),rejection_reason=$4,updated_at=now() WHERE id=$5`,
        [user.id,user.username,user.name,reason,doc.id]);await this.approvalHistory.record(qr,doc.id,'REJECTED','SUBMITTED','REJECTED',user.id,{...context,idempotencyKey:key,reason});}
      return {count:docs.length,documentIds:docs.map((d:any)=>d.id)};
    });
  }

  async defectiveItems(query:any) {
    const page=parsePage(query.page,1),pageSize=parsePage(query.pageSize,20,100),params:any[]=[];const where=[`lot.status='OPEN'`,`lot.remaining_qty>0`];
    const add=(value:any,sql:string)=>{if(value===undefined||value==='')return;params.push(value);where.push(sql.replace('$?',`$${params.length}`));};
    add(query.itemType,'i.item_type=$?');
    if(query.keyword){params.push(`%${query.keyword}%`);where.push(`(i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length} OR d.document_no ILIKE $${params.length})`);}
    const clause=`WHERE ${where.join(' AND ')}`;
    const [{count}]=await this.db.query(`SELECT count(*)::int count FROM defective_inventory_lots lot JOIN items i ON i.id=lot.item_id LEFT JOIN stock_documents d ON d.id=lot.source_document_id ${clause}`,params);
    params.push(pageSize,(page-1)*pageSize);
    const items=await this.db.query(`SELECT lot.id,lot.item_id "itemId",i.item_code "itemCode",i.name "itemName",i.item_type "itemType",i.unit,
      lot.warehouse_id "warehouseId",w.warehouse_code "warehouseCode",lot.location_id "locationId",loc.code "locationCode",
      lot.batch_id "batchId",b.batch_no "batchNo",lot.production_order_id "productionOrderId",po.order_no "productionOrderNo",
      d.document_no "sourceDocumentNo",lot.defect_reason "defectReason",lot.received_qty "receivedQty",lot.remaining_qty "remainingQty",lot.created_at "createdAt"
      FROM defective_inventory_lots lot JOIN items i ON i.id=lot.item_id JOIN warehouses w ON w.id=lot.warehouse_id
      JOIN warehouse_locations loc ON loc.id=lot.location_id LEFT JOIN inventory_batches b ON b.id=lot.batch_id
      LEFT JOIN stock_documents d ON d.id=lot.source_document_id LEFT JOIN production_orders po ON po.id=lot.production_order_id
      ${clause} ORDER BY lot.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
    const productionOrders=await this.db.query(`SELECT o.id,o.order_no "orderNo",o.finished_good_id "itemId",o.status,
      (o.planned_qty-o.completed_qty-COALESCE(pending.quantity,0))::text "availableCompletionQty"
      FROM production_orders o LEFT JOIN (
        SELECT d.production_order_id,sum(l.quantity) quantity FROM stock_documents d JOIN stock_document_lines l ON l.document_id=d.id
        WHERE d.document_type='PRODUCTION_COMPLETION' AND d.status='SUBMITTED' GROUP BY d.production_order_id
      ) pending ON pending.production_order_id=o.id
      WHERE o.status IN ('RELEASED','IN_PROGRESS') AND o.planned_qty-o.completed_qty-COALESCE(pending.quantity,0)>0
      ORDER BY o.created_at DESC`);
    const allocationOptions=await this.db.query(`SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",w.warehouse_type "warehouseType",
      z.id "zoneId",z.code "zoneCode",l.id "locationId",l.code "locationCode",l.name "locationName"
      FROM warehouses w JOIN warehouse_zones z ON z.warehouse_id=w.id JOIN warehouse_locations l ON l.zone_id=z.id
      WHERE w.status='ACTIVE' AND w.deleted_at IS NULL AND z.status='ACTIVE' AND z.deleted_at IS NULL AND l.status='ACTIVE' AND l.is_archived=false
      ORDER BY w.warehouse_code,z.code,l.code`);
    return {items,total:count,page,pageSize,productionOrders,allocationOptions};
  }

  async defectiveRecords(query:any) {
    const page=parsePage(query.page,1),pageSize=parsePage(query.pageSize,20,100),params:any[]=[];const where:string[]=[];
    if(query.itemType){params.push(query.itemType);where.push(`i.item_type=$${params.length}`);}
    const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
    const [{count}]=await this.db.query(`SELECT count(*)::int count FROM defective_disposition_records r JOIN defective_inventory_lots lot ON lot.id=r.lot_id JOIN items i ON i.id=lot.item_id ${clause}`,params);
    params.push(pageSize,(page-1)*pageSize);
    const items=await this.db.query(`SELECT r.id,r.action,r.quantity,r.reason,r.created_at "createdAt",r.processed_by_name "processedByName",
      i.item_code "itemCode",i.name "itemName",i.item_type "itemType",i.unit,d.document_no "documentNo",
      tw.warehouse_code "targetWarehouseCode",tl.code "targetLocationCode",po.order_no "productionOrderNo"
      FROM defective_disposition_records r JOIN defective_inventory_lots lot ON lot.id=r.lot_id JOIN items i ON i.id=lot.item_id
      JOIN stock_documents d ON d.id=r.document_id LEFT JOIN warehouses tw ON tw.id=r.target_warehouse_id
      LEFT JOIN warehouse_locations tl ON tl.id=r.target_location_id LEFT JOIN production_orders po ON po.id=r.production_order_id
      ${clause} ORDER BY r.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
    return {items,total:count,page,pageSize};
  }

  processDefective(lotId:string,dto:any,key:string|undefined,user:AuthUser) {
    return this.posting.executeIdempotent(user.id,key,'POST:/approvals/defective-items/:id/process',{lotId,...dto},async qr=>{
      const [lot]=await qr.query(`SELECT lot.*,i.item_type,i.item_code,i.name item_name FROM defective_inventory_lots lot JOIN items i ON i.id=lot.item_id WHERE lot.id=$1 FOR UPDATE OF lot`,[lotId]);
      if(!lot)throw new BusinessException('NOT_FOUND','不良品记录不存在');
      const quantity=new Decimal(dto.quantity);
      if(!quantity.isInteger()||!quantity.isPositive()||quantity.gt(lot.remaining_qty))throw new BusinessException('VALIDATION_ERROR','处理数量必须是整数且不能超过剩余待处理数量');
      if(!String(dto.reason||'').trim())throw new BusinessException('VALIDATION_ERROR','请填写处理原因、维修说明或处理意见');
      const isMaterial=lot.item_type==='MATERIAL';
      if(isMaterial&&!['RETURN','REPAIR_RESTOCK'].includes(dto.action))throw new BusinessException('VALIDATION_ERROR','原材料仅支持退货或维修重新入库');
      if(!isMaterial&&dto.action!=='RETURN_PRODUCTION')throw new BusinessException('VALIDATION_ERROR','成品只能退回生产任务');
      let targetWarehouseId:string|undefined,targetLocationId:string|undefined,productionOrderId:string|undefined;
      if(dto.action==='REPAIR_RESTOCK'){
        const [target]=await qr.query(`SELECT l.id,l.warehouse_id FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id
          WHERE l.id=$1 AND l.warehouse_id=$2 AND l.status='ACTIVE' AND l.is_archived=false AND w.status='ACTIVE' AND w.deleted_at IS NULL AND w.warehouse_type='RAW'`,[dto.targetLocationId,dto.targetWarehouseId]);
        if(!target)throw new BusinessException('VALIDATION_ERROR','维修重新入库必须选择启用的原材料仓库和库位');
        targetWarehouseId=dto.targetWarehouseId;targetLocationId=dto.targetLocationId;
      }
      if(dto.action==='RETURN_PRODUCTION'){
        productionOrderId=lot.production_order_id||dto.productionOrderId;
        const [order]=await qr.query(`SELECT o.id,o.status,o.planned_qty,o.completed_qty,
          COALESCE((SELECT sum(l.quantity) FROM stock_documents d JOIN stock_document_lines l ON l.document_id=d.id WHERE d.production_order_id=o.id AND d.document_type='PRODUCTION_COMPLETION' AND d.status='SUBMITTED'),0) pending_qty
          FROM production_orders o WHERE o.id=$1 AND o.finished_good_id=$2 FOR UPDATE`,[productionOrderId,lot.item_id]);
        if(!order||!['RELEASED','IN_PROGRESS'].includes(order.status)||new Decimal(order.planned_qty).sub(order.completed_qty).sub(order.pending_qty).lt(quantity))throw new BusinessException('VALIDATION_ERROR','请选择同一成品且有足够待完工量的生产任务');
      }
      const documentType=dto.action==='RETURN'?DocumentType.DEFECTIVE_RETURN:dto.action==='REPAIR_RESTOCK'?DocumentType.DEFECTIVE_REPAIR_RESTOCK:DocumentType.DEFECTIVE_PRODUCTION_RETURN;
      const doc=await this.posting.createDocument(qr,{documentType,warehouseId:lot.warehouse_id,productionOrderId,notes:String(dto.reason).trim(),lines:[{
        itemId:lot.item_id,quantity:quantity.toFixed(0),direction:Direction.OUT,sourceWarehouseId:lot.warehouse_id,locationId:lot.location_id,batchId:lot.batch_id,
        targetWarehouseId,targetLocationId,targetBatchId:lot.batch_id,
      }],operator:user} as any,user.id);
      const posted=await this.posting.applyDocument(qr,doc.id,user.id,['DRAFT']);
      const remaining=new Decimal(lot.remaining_qty).sub(quantity);
      await qr.query(`UPDATE defective_inventory_lots SET remaining_qty=$1,status=$2,updated_at=now() WHERE id=$3`,[remaining.toFixed(0),remaining.isZero()?'RESOLVED':'OPEN',lotId]);
      if(productionOrderId)await qr.query(`UPDATE production_orders SET status='IN_PROGRESS',updated_at=now() WHERE id=$1`,[productionOrderId]);
      const snap=snapshotUser(user);
      await qr.query(`INSERT INTO defective_disposition_records(lot_id,document_id,action,quantity,reason,target_warehouse_id,target_location_id,production_order_id,processed_by_user_id,processed_by_username,processed_by_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[lotId,doc.id,dto.action,quantity.toFixed(0),String(dto.reason).trim(),targetWarehouseId||null,targetLocationId||null,productionOrderId||null,snap.userId,snap.username,snap.name]);
      return {...posted,lotId,remainingQty:remaining.toFixed(0)};
    });
  }
}
