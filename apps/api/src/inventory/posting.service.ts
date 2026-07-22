import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { BusinessException } from '../common/business.exception';
import { Direction, DocumentType } from '../common/constants';

export interface DocumentLineInput { itemId:string; quantity:string; direction:Direction; notes?:string; }
export interface NewDocumentInput { documentType:DocumentType; warehouseId:string; productionOrderId?:string; originalDocumentId?:string; notes?:string; lines:DocumentLineInput[]; }

export const stableHash = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

@Injectable()
export class InventoryPostingService {
  constructor(private readonly db:DataSource,private readonly audit:AuditService){}

  async executeIdempotent<T>(userId:string,key:string|undefined,endpoint:string,payload:unknown,work:(qr:QueryRunner)=>Promise<T>):Promise<T>{
    if(!key?.trim())throw new BusinessException('VALIDATION_ERROR','缺少 Idempotency-Key 请求头');
    if(key.length>100)throw new BusinessException('VALIDATION_ERROR','Idempotency-Key 长度不能超过100');
    const hash=stableHash(payload);const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();
    try{
      const inserted=await qr.query(`INSERT INTO idempotency_keys(id,user_id,idempotency_key,endpoint,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,[randomUUID(),userId,key,endpoint,hash]);
      if(!inserted.length){
        const [existing]=await qr.query(`SELECT request_hash,response_payload FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 AND endpoint=$3 FOR UPDATE`,[userId,key,endpoint]);
        if(!existing)throw new BusinessException('IDEMPOTENCY_CONFLICT','幂等记录状态异常',HttpStatus.CONFLICT);
        if(existing.request_hash!==hash)throw new BusinessException('IDEMPOTENCY_CONFLICT','相同幂等键对应不同请求内容',HttpStatus.CONFLICT);
        if(existing.response_payload===null)throw new BusinessException('IDEMPOTENCY_CONFLICT','相同请求正在处理中',HttpStatus.CONFLICT);
        await qr.commitTransaction();return existing.response_payload as T;
      }
      const result=await work(qr);
      await qr.query(`UPDATE idempotency_keys SET response_payload=$1 WHERE user_id=$2 AND idempotency_key=$3 AND endpoint=$4`,[JSON.stringify(result),userId,key,endpoint]);
      await qr.commitTransaction();return result;
    }catch(e){if(qr.isTransactionActive)await qr.rollbackTransaction();throw e;}finally{await qr.release();}
  }

  async createDocument(qr:QueryRunner,input:NewDocumentInput,userId:string){
    if(!input.lines.length)throw new BusinessException('VALIDATION_ERROR','单据至少包含一条明细');
    if(new Set(input.lines.map(l=>l.itemId)).size!==input.lines.length)throw new BusinessException('VALIDATION_ERROR','同一物料不能重复');
    const id=randomUUID();const prefix:Record<string,string>={MATERIAL_INBOUND:'MI',FINISHED_INBOUND:'FI',PRODUCTION_ISSUE:'PI',PRODUCTION_RETURN:'PR',PRODUCTION_COMPLETION:'PC',FINISHED_OUTBOUND:'FO',REVERSAL:'RV'};
    const documentNo=`${prefix[input.documentType]}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${randomUUID().slice(0,8).toUpperCase()}`;
    await qr.query(`INSERT INTO stock_documents(id,document_no,document_type,status,warehouse_id,production_order_id,original_document_id,notes,created_by) VALUES($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8)`,[id,documentNo,input.documentType,input.warehouseId,input.productionOrderId||null,input.originalDocumentId||null,input.notes||null,userId]);
    for(const line of input.lines)await qr.query(`INSERT INTO stock_document_lines(id,document_id,item_id,quantity,direction,notes) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),id,line.itemId,line.quantity,line.direction,line.notes||null]);
    return {id,documentNo};
  }

  async applyDocument(qr:QueryRunner,documentId:string,userId:string){
    const [doc]=await qr.query(`SELECT d.*,w.warehouse_code FROM stock_documents d JOIN warehouses w ON w.id=d.warehouse_id WHERE d.id=$1 FOR UPDATE`,[documentId]);
    if(!doc)throw new BusinessException('NOT_FOUND','库存单据不存在');
    if(doc.status!=='DRAFT')throw new BusinessException('INVALID_STATUS','只有草稿单据可以过账');
    const lines=await qr.query(`SELECT l.*,i.item_code,i.name item_name,i.item_type,i.status item_status FROM stock_document_lines l JOIN items i ON i.id=l.item_id WHERE l.document_id=$1 ORDER BY l.item_id`,[documentId]);
    if(!lines.length)throw new BusinessException('VALIDATION_ERROR','单据没有明细');
    this.validateWarehouseAndItems(doc,lines);
    const postedLines:any[]=[];
    for(const line of lines){
      await qr.query(`INSERT INTO stock_balances(id,warehouse_id,item_id,on_hand_qty) VALUES($1,$2,$3,0) ON CONFLICT(warehouse_id,item_id) DO NOTHING`,[randomUUID(),doc.warehouse_id,line.item_id]);
      const [balance]=await qr.query(`SELECT id,on_hand_qty FROM stock_balances WHERE warehouse_id=$1 AND item_id=$2 FOR UPDATE`,[doc.warehouse_id,line.item_id]);
      const delta=new Decimal(line.quantity).mul(line.direction===Direction.IN?1:-1);const after=new Decimal(balance.on_hand_qty).add(delta);
      if(after.isNegative())throw new BusinessException('INSUFFICIENT_STOCK',`${line.item_code} ${line.item_name} 库存不足：可用 ${balance.on_hand_qty}，本次 ${line.quantity}`,HttpStatus.CONFLICT,{itemId:line.item_id,itemCode:line.item_code,availableQty:balance.on_hand_qty,requestQty:line.quantity});
      const value=after.toFixed(4);await qr.query(`UPDATE stock_balances SET on_hand_qty=$1,version=version+1,updated_at=now() WHERE id=$2`,[value,balance.id]);
      await qr.query(`INSERT INTO stock_transactions(id,source_document_id,warehouse_id,item_id,delta_qty,balance_after,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),documentId,doc.warehouse_id,line.item_id,delta.toFixed(4),value,userId]);
      postedLines.push({itemId:line.item_id,itemCode:line.item_code,quantity:new Decimal(line.quantity).toFixed(4),direction:line.direction,balanceAfter:value});
    }
    await qr.query(`UPDATE stock_documents SET status='POSTED',posted_by=$1,posted_at=now(),updated_at=now() WHERE id=$2`,[userId,documentId]);
    await this.audit.log(userId,'POST_STOCK_DOCUMENT','stock_documents',documentId,{documentType:doc.document_type,lines:postedLines},qr.manager);
    return {id:documentId,documentNo:doc.document_no,documentType:doc.document_type,status:'POSTED',lines:postedLines};
  }

  private validateWarehouseAndItems(doc:any,lines:any[]){
    if(doc.document_type===DocumentType.REVERSAL)return;
    const rawTypes=[DocumentType.MATERIAL_INBOUND,DocumentType.PRODUCTION_ISSUE,DocumentType.PRODUCTION_RETURN];
    const fgTypes=[DocumentType.FINISHED_INBOUND,DocumentType.PRODUCTION_COMPLETION,DocumentType.FINISHED_OUTBOUND];
    if(doc.document_type===DocumentType.FINISHED_INBOUND&&lines.some(l=>l.item_status!=='ACTIVE'))throw new BusinessException('VALIDATION_ERROR','成品入库只能包含启用物料');
    if(rawTypes.includes(doc.document_type)&&doc.warehouse_code!=='RAW')throw new BusinessException('VALIDATION_ERROR','该单据必须使用 RAW 原材料库');
    if(fgTypes.includes(doc.document_type)&&doc.warehouse_code!=='FG')throw new BusinessException('VALIDATION_ERROR','该单据必须使用 FG 成品库');
    if(rawTypes.includes(doc.document_type)&&lines.some(l=>l.item_type!=='MATERIAL'))throw new BusinessException('VALIDATION_ERROR','该单据只能包含原材料');
    if(fgTypes.includes(doc.document_type)&&lines.some(l=>l.item_type!=='FINISHED_GOOD'))throw new BusinessException('VALIDATION_ERROR','该单据只能包含成品');
  }
}
