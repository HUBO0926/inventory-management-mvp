import { Body, Controller, Get, Headers, Param, Post, Put, Query, Res } from '@nestjs/common';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { PickingOrdersService } from './picking-orders.service';

@Controller()
export class PickingOrdersController {
  constructor(private readonly service:PickingOrdersService){}
  @Permissions('production.view') @Get('production-orders/:id/material-shortage') shortage(@Param('id')id:string){return this.service.shortages(id);}
  @Permissions('production.view') @Post('production-orders/:id/material-shortage/check') check(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.checkShortage(id,u);}
  @Permissions('production.view') @Get('production-orders/:id/material-shortage/export') async export(@Param('id')id:string,@Res()res:any){const rows=await this.service.shortages(id);const esc=(v:any)=>`"${String(v??'').replace(/"/g,'""')}"`;const csv='\uFEFF'+[['物料编码','物料名称','型号','规格','单位','BOM需求','已领','已退','净领料','本次待领','可用库存','缺料'],...rows.map((r:any)=>[r.itemCode,r.itemName,r.model,r.spec,r.unit,r.requiredQty,r.issuedQty,r.returnedQty,r.netIssuedQty,r.pendingQty,r.availableQty,r.shortageQty])].map(row=>row.map(esc).join(',')).join('\r\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="shortage-${id}.csv"`);res.send(csv);}
  @Permissions('production.issue') @Post('production-orders/:id/picking-orders/manual') manual(@Param('id')id:string,@Body()dto:any,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.createManual(id,dto,key,u);}
  @Permissions('production.issue') @Post('production-orders/:id/picking-orders/auto-generate') auto(@Param('id')id:string,@Body()dto:any,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.createAuto(id,dto,key,u);}
  @Permissions('production.issue') @Get('picking-orders/:id') get(@Param('id')id:string){return this.service.get(id);}
  @Permissions('production.issue') @Put('picking-orders/:id') update(@Param('id')id:string,@Body()dto:any,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.update(id,dto,key,u);}
  @Permissions('production.issue') @Post('picking-orders/:id/auto-allocate') allocate(@Param('id')id:string,@Body()dto:any,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.autoAllocate(id,dto,key,u);}
  @Permissions('stock.submit') @Post('picking-orders/:id/submit') submit(@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.submit(id,key,u);}
  @Permissions('stock.withdraw') @Post('picking-orders/:id/withdraw') withdraw(@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.withdraw(id,key,u);}
  @Permissions('stock.edit') @Post('picking-orders/:id/cancel') cancel(@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.cancel(id,key,u);}
  @Permissions('stock.submit') @Post('picking-orders/:id/resubmit') resubmit(@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.submit(id,key,u);}
  @Permissions('inventory.view') @Get('inventory/available-locations') locations(@Query()q:any){return this.service.availableLocations(q);}
  @Permissions('inventory.view') @Post('inventory/validate-allocation') validate(@Body()dto:any){return this.service.validateAllocation(dto);}
}
