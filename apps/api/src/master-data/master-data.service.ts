import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BusinessException } from '../common/business.exception';
import { parsePage } from '../common/validation';

type EntityKind = 'category'|'unit'|'zone'|'location'|'batch';
type Spec = { table:string; code:string; name:string; refs:string[]; parent?:string };

const specs:Record<EntityKind,Spec>={
  category:{table:'item_categories',code:'code',name:'name',refs:['items.category_id']},
  unit:{table:'units',code:'code',name:'name',refs:['items.unit_id']},
  zone:{table:'warehouse_zones',code:'code',name:'name',parent:'warehouse_id',refs:['warehouse_locations.zone_id']},
  location:{table:'warehouse_locations',code:'code',name:'name',parent:'warehouse_id',refs:['stock_document_lines.location_id','stock_balances.location_id','stock_transactions.location_id']},
  batch:{table:'inventory_batches',code:'batch_no',name:'batch_no',parent:'item_id',refs:['stock_document_lines.batch_id','stock_balances.batch_id','stock_transactions.batch_id']},
};

@Injectable()
export class MasterDataService {
  constructor(private readonly db:DataSource){}
  async listCategories(q:any){
    const page=parsePage(q.page,1),pageSize=parsePage(q.pageSize,20,100),offset=(page-1)*pageSize;
    const params:any[]=[],where:string[]=[];
    if(q.itemType){params.push(q.itemType);where.push(`c.item_type=$${params.length}`);}
    if(q.keyword){params.push(`%${q.keyword.trim()}%`);where.push(`(c.code ILIKE $${params.length} OR c.name ILIKE $${params.length})`);}
    if(q.status){params.push(q.status);where.push(`c.status=$${params.length}`);}
    const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
    const[{count}]=await this.db.query(`SELECT count(*)::int count FROM item_categories c ${clause}`,params);
    params.push(pageSize,offset);
    const rows=await this.db.query(
      `SELECT c.id,c.code,c.name,c.item_type "itemType",c.sort_order "sortOrder",
        c.status,false "systemProtected",c.created_at "createdAt",c.updated_at "updatedAt",
        count(i.id)::int "itemCount",
        true "canDelete"
       FROM item_categories c
       LEFT JOIN items i ON i.category_id=c.id
       ${clause}
       GROUP BY c.id
       ORDER BY c.item_type,c.sort_order,c.code
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params,
    );
    return{items:rows,total:count,page,pageSize};
  }
  async getCategory(id:string){
    const[row]=await this.db.query(
      `SELECT c.id,c.code,c.name,c.item_type "itemType",c.sort_order "sortOrder",
        c.status,false "systemProtected",c.created_at "createdAt",c.updated_at "updatedAt",
        count(i.id)::int "itemCount",
        true "canDelete"
       FROM item_categories c
       LEFT JOIN items i ON i.category_id=c.id
       WHERE c.id=$1
       GROUP BY c.id`,
      [id],
    );
    if(!row)throw new BusinessException('NOT_FOUND','物料分类不存在');
    return row;
  }
  async createCategory(dto:any){
    const code=String(dto.code).trim().toUpperCase();
    const name=String(dto.name).trim();
    if(!name)throw new BusinessException('VALIDATION_ERROR','分类名称不能为空');
    try{
      const[row]=await this.db.query(
        `INSERT INTO item_categories(code,name,item_type,sort_order)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [code,name,dto.itemType,dto.sortOrder??0],
      );
      return this.getCategory(row.id);
    }catch(error:any){
      if(error.code==='23505')throw new BusinessException('DUPLICATE_CODE','该物料类型下的分类编码已存在',HttpStatus.CONFLICT);
      throw error;
    }
  }
  async updateCategory(id:string,dto:any){
    const current=await this.getCategory(id);
    if(dto.name!==undefined&&!String(dto.name).trim())throw new BusinessException('VALIDATION_ERROR','分类名称不能为空');
    const fields:string[]=[],params:any[]=[];
    const allowed:Record<string,string>={code:'code',name:'name',status:'status',sortOrder:'sort_order'};
    for(const[key,column]of Object.entries(allowed)){
      if(dto[key]!==undefined){
        const value=key==='code'?String(dto[key]).trim().toUpperCase():key==='name'?String(dto[key]).trim():dto[key];
        params.push(value);fields.push(`${column}=$${params.length}`);
      }
    }
    if(!fields.length)return current;
    params.push(id);
    try{
      await this.db.query(
        `UPDATE item_categories SET ${fields.join(',')},updated_at=now() WHERE id=$${params.length}`,
        params,
      );
    }catch(error:any){
      if(error.code==='23505')throw new BusinessException('DUPLICATE_CODE','该物料类型下的分类编码已存在',HttpStatus.CONFLICT);
      throw error;
    }
    return this.getCategory(id);
  }
  async removeCategory(id:string){
    const qr=this.db.createQueryRunner();await qr.connect();await qr.startTransaction();
    try{
      const[current]=await qr.query(`SELECT id FROM item_categories WHERE id=$1 FOR UPDATE`,[id]);
      if(!current)throw new BusinessException('NOT_FOUND','物料分类不存在');
      const[{count}]=await qr.query(`SELECT count(*)::int count FROM items WHERE category_id=$1`,[id]);
      await qr.query(`UPDATE items SET category_id=NULL,updated_at=now() WHERE category_id=$1`,[id]);
      await qr.query(`DELETE FROM item_categories WHERE id=$1`,[id]);
      await qr.commitTransaction();
      return{id,detachedItemCount:count};
    }catch(error){await qr.rollbackTransaction();throw error;}finally{await qr.release();}
  }
  async list(kind:EntityKind,q:any){
    const s=specs[kind],page=parsePage(q.page,1),pageSize=parsePage(q.pageSize,20,100),offset=(page-1)*pageSize;
    const p:any[]=[],w:string[]=[];
    if(q.keyword){p.push(`%${q.keyword}%`);w.push(`(${s.code} ILIKE $${p.length} OR ${s.name} ILIKE $${p.length})`);}
    if(q.status){p.push(q.status);w.push(`status=$${p.length}`);}
    if(s.parent&&q.parentId){p.push(q.parentId);w.push(`${s.parent}=$${p.length}`);}
    const clause=w.length?`WHERE ${w.join(' AND ')}`:'';
    const [{count}]=await this.db.query(`SELECT count(*)::int count FROM ${s.table} ${clause}`,p);
    p.push(pageSize,offset);
    const rows=await this.db.query(`SELECT * FROM ${s.table} ${clause} ORDER BY ${s.code} LIMIT $${p.length-1} OFFSET $${p.length}`,p);
    return {items:rows,total:count,page,pageSize};
  }
  async get(kind:EntityKind,id:string){const s=specs[kind];const [row]=await this.db.query(`SELECT * FROM ${s.table} WHERE id=$1`,[id]);if(!row)throw new BusinessException('NOT_FOUND','数据不存在');return row;}
  async create(kind:EntityKind,dto:any){
    const s=specs[kind];
    const columns=kind==='location'
      ? ['code','name','warehouse_id','zone_id']
      : kind==='batch'
        ? ['batch_no','item_id','notes']
        : [s.code,s.name,...(s.parent?[s.parent]:[])];
    const values=kind==='location'
      ? [dto.code,dto.name,dto.warehouseId,dto.zoneId]
      : kind==='batch'
        ? [dto.batchNo,dto.itemId,dto.notes||null]
        : [dto.code,dto.name,...(s.parent?[dto.warehouseId]:[])];
    const params=values.map((_,i)=>`$${i+1}`).join(',');
    try{const [row]=await this.db.query(`INSERT INTO ${s.table}(${columns.join(',')}) VALUES(${params}) RETURNING *`,values);return row;}
    catch(e:any){if(e.code==='23505')throw new BusinessException('DUPLICATE_CODE','编码或批次号已存在',HttpStatus.CONFLICT);throw e;}
  }
  async update(kind:EntityKind,id:string,dto:any){
    const s=specs[kind];const allowed:any=kind==='batch'?{status:'status',notes:'notes'}:{name:'name',status:'status'};const sets:string[]=[],p:any[]=[];
    for(const[key,col]of Object.entries(allowed))if(dto[key]!==undefined){p.push(dto[key]);sets.push(`${col}=$${p.length}`);}
    if(!sets.length)return this.get(kind,id);p.push(id);
    const [row]=await this.db.query(`UPDATE ${s.table} SET ${sets.join(',')},updated_at=now() WHERE id=$${p.length} RETURNING *`,p);
    if(!row)throw new BusinessException('NOT_FOUND','数据不存在');return row;
  }
  async remove(kind:EntityKind,id:string){
    const s=specs[kind];const references:any[]=[];
    for(const ref of s.refs){const[table,column]=ref.split('.');const[{count}]=await this.db.query(`SELECT count(*)::int count FROM ${table} WHERE ${column}=$1`,[id]);if(count)references.push({table,count});}
    if(references.length)throw new BusinessException('REFERENCE_CONFLICT','数据已被引用，只能停用',HttpStatus.CONFLICT,references);
    const result=await this.db.query(`DELETE FROM ${s.table} WHERE id=$1`,[id]);if(!result[1])throw new BusinessException('NOT_FOUND','数据不存在');return{id};
  }
}
