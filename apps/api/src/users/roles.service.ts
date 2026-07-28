import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BusinessException } from '../common/business.exception';

@Injectable()
export class RolesService{
  constructor(private db:DataSource){}
  list(){return this.db.query(`SELECT r.id,r.code,r.name,r.status,r.system_protected "systemProtected",
    COALESCE(array_agg(p.code) FILTER(WHERE p.code IS NOT NULL),'{}') permissions
    FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
    GROUP BY r.id ORDER BY r.system_protected DESC,r.code`);}
  permissions(){return this.db.query(`SELECT id,code,name FROM permissions ORDER BY code`);}
  async create(dto:any){try{const [r]=await this.db.query(`INSERT INTO roles(code,name) VALUES($1,$2) RETURNING *`,[dto.code.trim(),dto.name.trim()]);await this.setPermissions(r.id,dto.permissions);return this.get(r.id);}catch(e:any){if(e.code==='23505')throw new BusinessException('DUPLICATE_CODE','角色编码已存在',HttpStatus.CONFLICT);throw e;}}
  async get(id:string){const rows=await this.list();const row=rows.find((x:any)=>x.id===id);if(!row)throw new BusinessException('NOT_FOUND','角色不存在');return row;}
  async update(id:string,dto:any){const [role]=await this.db.query(`UPDATE roles SET name=COALESCE($1,name),status=COALESCE($2,status),updated_at=now() WHERE id=$3 RETURNING *`,[dto.name??null,dto.status??null,id]);if(!role)throw new BusinessException('NOT_FOUND','角色不存在');if(dto.permissions)await this.setPermissions(id,dto.permissions);return this.get(id);}
  async remove(id:string){const [role]=await this.db.query(`SELECT system_protected FROM roles WHERE id=$1`,[id]);if(!role)throw new BusinessException('NOT_FOUND','角色不存在');if(role.system_protected)throw new BusinessException('REFERENCE_CONFLICT','系统内置角色不能删除',HttpStatus.CONFLICT);const[{count}]=await this.db.query(`SELECT count(*)::int count FROM users WHERE role_id=$1`,[id]);if(count)throw new BusinessException('REFERENCE_CONFLICT','角色已分配给账号，只能停用',HttpStatus.CONFLICT,{users:count});await this.db.query(`DELETE FROM roles WHERE id=$1`,[id]);return{id};}
  private async setPermissions(roleId:string,codes:string[]){const rows=await this.db.query(`SELECT id,code FROM permissions WHERE code=ANY($1::text[])`,[codes]);if(rows.length!==new Set(codes).size)throw new BusinessException('VALIDATION_ERROR','包含不存在的权限编码');await this.db.transaction(async m=>{await m.query(`DELETE FROM role_permissions WHERE role_id=$1`,[roleId]);if(rows.length)await m.query(`INSERT INTO role_permissions(role_id,permission_id) SELECT $1,unnest($2::uuid[])`,[roleId,rows.map((x:any)=>x.id)]);});}
}
