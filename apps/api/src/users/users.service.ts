import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { BusinessException } from '../common/business.exception';
import { AuditService } from '../audit/audit.service';
import { parsePage } from '../common/validation';

@Injectable()
export class UsersService {
  constructor(private readonly db: DataSource, private readonly audit: AuditService) {}
  async list(q: any) {
    const page=parsePage(q.page,1), pageSize=parsePage(q.pageSize,20,100), offset=(page-1)*pageSize;
    const params:any[]=[]; let where=''; if(q.keyword){params.push(`%${q.keyword}%`);where=`WHERE username ILIKE $1 OR name ILIKE $1`;}
    const [{count}]=await this.db.query(`SELECT count(*)::int count FROM users ${where}`,params);
    params.push(pageSize,offset); const rows=await this.db.query(`SELECT id,username,name,role,status,created_at "createdAt" FROM users ${where} ORDER BY username LIMIT $${params.length-1} OFFSET $${params.length}`,params);
    return {items:rows,total:count,page,pageSize};
  }
  async create(dto:any,userId:string){try{const hash=await bcrypt.hash(dto.password,12);const [row]=await this.db.query(`INSERT INTO users(username,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,name,role,status`,[dto.username.trim(),dto.name.trim(),hash,dto.role]);await this.audit.log(userId,'CREATE_USER','users',row.id,{username:dto.username,role:dto.role});return row;}catch(e:any){if(e.code==='23505')throw new BusinessException('DUPLICATE_CODE','账号已存在');throw e;}}
  async status(id:string,status:string,userId:string){const [row]=await this.db.query(`UPDATE users SET status=$1,updated_at=now() WHERE id=$2 RETURNING id,username,name,role,status`,[status,id]);if(!row)throw new BusinessException('NOT_FOUND','账号不存在');await this.audit.log(userId,'UPDATE_USER_STATUS','users',id,{status});return row;}
  async reset(id:string,password:string,userId:string){const hash=await bcrypt.hash(password,12);const result=await this.db.query(`UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2`,[hash,id]);if(!result[1])throw new BusinessException('NOT_FOUND','账号不存在');await this.audit.log(userId,'RESET_PASSWORD','users',id);return {id};}
}
