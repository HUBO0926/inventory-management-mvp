import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { BusinessException } from '../common/business.exception';
import { AuditService } from '../audit/audit.service';
import { parsePage } from '../common/validation';

@Injectable()
export class BomsService {
  constructor(private readonly db: DataSource, private readonly audit: AuditService) {}
  async list(q:any){
    const page=parsePage(q.page,1),pageSize=parsePage(q.pageSize,20,100),offset=(page-1)*pageSize;const params:any[]=[];const where:string[]=[];
    if(q.keyword){params.push(`%${q.keyword}%`);where.push(`(i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length})`);}if(q.status){params.push(q.status);where.push(`b.status=$${params.length}`);}const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
    const [{count}]=await this.db.query(`SELECT count(*)::int count FROM boms b JOIN items i ON i.id=b.finished_good_id ${clause}`,params);params.push(pageSize,offset);
    const rows=await this.db.query(`SELECT b.id,b.version,b.status,b.notes,i.id "finishedGoodId",i.item_code "finishedGoodCode",i.name "finishedGoodName",count(bi.id)::int "lineCount",b.created_at "createdAt" FROM boms b JOIN items i ON i.id=b.finished_good_id LEFT JOIN bom_items bi ON bi.bom_id=b.id ${clause} GROUP BY b.id,i.id ORDER BY b.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);return {items:rows,total:count,page,pageSize};
  }
  async get(id:string){const [bom]=await this.db.query(`SELECT b.id,b.version,b.status,b.notes,i.id "finishedGoodId",i.item_code "finishedGoodCode",i.name "finishedGoodName" FROM boms b JOIN items i ON i.id=b.finished_good_id WHERE b.id=$1`,[id]);if(!bom)throw new BusinessException('NOT_FOUND','BOM不存在');bom.lines=await this.db.query(`SELECT bi.material_id "materialId",i.item_code "itemCode",i.name,i.unit,bi.qty_per "qtyPer" FROM bom_items bi JOIN items i ON i.id=bi.material_id WHERE bi.bom_id=$1 ORDER BY i.item_code`,[id]);return bom;}
  async save(id:string|null,dto:any,userId:string){
    if(new Set(dto.lines.map((l:any)=>l.materialId)).size!==dto.lines.length)throw new BusinessException('VALIDATION_ERROR','BOM材料不能重复');
    const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();try{
      const [fg]=await qr.query(`SELECT id FROM items WHERE id=$1 AND item_type='FINISHED_GOOD' AND status='ACTIVE'`,[dto.finishedGoodId]);if(!fg)throw new BusinessException('VALIDATION_ERROR','成品不存在或已停用');
      const materialRows=await qr.query(`SELECT id FROM items WHERE id=ANY($1::uuid[]) AND item_type='MATERIAL' AND status='ACTIVE'`,[dto.lines.map((l:any)=>l.materialId)]);if(materialRows.length!==dto.lines.length)throw new BusinessException('VALIDATION_ERROR','BOM包含不存在、停用或非原材料物料');
      let bomId=id;
      if(id){const [existing]=await qr.query(`SELECT id FROM boms WHERE id=$1 FOR UPDATE`,[id]);if(!existing)throw new BusinessException('NOT_FOUND','BOM不存在');await qr.query(`UPDATE boms SET finished_good_id=$1,version=$2,status=$3,notes=$4,updated_at=now() WHERE id=$5`,[dto.finishedGoodId,dto.version,dto.status,dto.notes||null,id]);await qr.query(`DELETE FROM bom_items WHERE bom_id=$1`,[id]);}
      else{bomId=randomUUID();await qr.query(`INSERT INTO boms(id,finished_good_id,version,status,notes) VALUES($1,$2,$3,$4,$5)`,[bomId,dto.finishedGoodId,dto.version,dto.status,dto.notes||null]);}
      for(const line of dto.lines)await qr.query(`INSERT INTO bom_items(id,bom_id,material_id,qty_per) VALUES($1,$2,$3,$4)`,[randomUUID(),bomId,line.materialId,line.qtyPer]);
      await this.audit.log(userId,id?'UPDATE_BOM':'CREATE_BOM','boms',bomId!,dto,qr.manager);await qr.commitTransaction();return this.get(bomId!);
    }catch(e:any){await qr.rollbackTransaction();if(e.code==='23505')throw new BusinessException('DUPLICATE_CODE','同一成品已有相同版本或启用BOM');throw e;}finally{await qr.release();}
  }
}
