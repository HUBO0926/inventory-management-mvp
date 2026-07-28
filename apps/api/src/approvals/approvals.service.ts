import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser, Role } from '../common/constants';
import { BusinessException } from '../common/business.exception';
import { parsePage } from '../common/validation';
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
  async detail(id:string,user:AuthUser) { const p:any[]=[]; const visible=await this.viewWhere(user,p); p.push(id); const [doc]=await this.db.query(`SELECT d.id FROM stock_documents d WHERE ${visible} AND d.id=$${p.length}` ,p); if(!doc) throw new BusinessException('FORBIDDEN','无权查看该审核记录',HttpStatus.FORBIDDEN); return this.stock.get(id); }
  async history(id:string,user:AuthUser) { await this.detail(id,user); return this.db.query(`SELECT id,action,status_before "statusBefore",status_after "statusAfter",actor_username "actorUsername",actor_name "actorName",reason_code "reasonCode",reason,request_id "requestId",ip,source,created_at "createdAt" FROM approval_records WHERE document_id=$1 ORDER BY created_at DESC`,[id]); }
  async approve(id:string,dto:any,key:string|undefined,user:AuthUser, context:any={}) { await this.requireAction(id,user,'approve'); return this.stock.approve(id,dto,key,user.id,{...context,idempotencyKey:key}); }
  async reject(id:string,dto:any,key:string|undefined,user:AuthUser, context:any={}) { await this.requireAction(id,user,'reject'); return this.stock.reject(id,dto.reason,user.id,{...context,idempotencyKey:key,reasonCode:dto.reasonCode}); }
  async batchReject(ids:string[],reason:string,key:string|undefined,user:AuthUser,context:any={}) {
    if (!ids?.length || !reason?.trim()) throw new BusinessException('VALIDATION_ERROR','请选择单据并填写统一驳回原因');
    return this.posting.executeIdempotent(user.id,key,'POST:/approvals/batch-reject',{ids:[...ids].sort(),reason},async qr=>{
      const docs=await qr.query(`SELECT id,document_type,warehouse_id,created_by,status FROM stock_documents WHERE id=ANY($1::uuid[]) FOR UPDATE`,[ids]); if(docs.length!==ids.length) throw new BusinessException('NOT_FOUND','存在不存在的审核单据'); const scopes=await this.scopes(user);
      for(const doc of docs){if(doc.status!=='SUBMITTED')throw new BusinessException('INVALID_STATUS','批量驳回包含非待审核单据');if(!this.scopeMatch(doc,scopes)||(doc.created_by===user.id&&!scopes.some(s=>(!s.document_type||s.document_type===doc.document_type)&&(!s.warehouse_id||s.warehouse_id===doc.warehouse_id)&&s.allow_self_approval)))throw new BusinessException('FORBIDDEN','批量驳回包含无权限单据',HttpStatus.FORBIDDEN);}
      for(const doc of docs){await qr.query(`UPDATE stock_documents SET status='REJECTED',rejected_by=$1,rejected_at=now(),rejection_reason=$2,updated_at=now() WHERE id=$3`,[user.id,reason,doc.id]);await this.approvalHistory.record(qr,doc.id,'REJECTED','SUBMITTED','REJECTED',user.id,{...context,idempotencyKey:key,reason});}
      return {count:docs.length,documentIds:docs.map((d:any)=>d.id)};
    });
  }
}
