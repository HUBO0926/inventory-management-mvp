import { Controller, Get, Query } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Permissions } from '../auth/auth.decorators';
import { parsePage } from '../common/validation';
@Controller('audit/logs')
export class AuditController{constructor(private db:DataSource){}
  @Permissions('audit.view')@Get()async list(@Query()q:any){
    const page=parsePage(q.page,1),pageSize=parsePage(q.pageSize,20,100),offset=(page-1)*pageSize;
    const p:any[]=[],w:string[]=[];if(q.action){p.push(q.action);w.push(`l.action=$${p.length}`)}if(q.userId){p.push(q.userId);w.push(`l.user_id=$${p.length}`)}
    const clause=w.length?`WHERE ${w.join(' AND ')}`:'';const[{count}]=await this.db.query(`SELECT count(*)::int count FROM operation_logs l ${clause}`,p);
    p.push(pageSize,offset);const items=await this.db.query(`SELECT l.id,l.action,l.entity_type "entityType",l.entity_id "entityId",
      l.details,l.request_id "requestId",l.ip,l.result,l.error_code "errorCode",l.app_version "appVersion",
      l.created_at "createdAt",u.username FROM operation_logs l LEFT JOIN users u ON u.id=l.user_id ${clause}
      ORDER BY l.created_at DESC LIMIT $${p.length-1} OFFSET $${p.length}`,p);return{items,total:count,page,pageSize};
  }
}
