import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { IsQuantity } from '../common/validation';
import { ProductionService } from './production.service';

class CreateOrderDto{@IsString()finishedGoodId:string;@IsQuantity()plannedQty:string;@IsOptional()@IsString()defaultIssueWarehouseId?:string;@IsOptional()@IsDateString()plannedDate?:string;@IsOptional()@IsString()@MaxLength(500)notes?:string;}
class UpdateOrderDto{@IsOptional()@IsQuantity()plannedQty?:string;@IsOptional()@IsString()defaultIssueWarehouseId?:string;@IsOptional()@IsDateString()plannedDate?:string;@IsOptional()@IsString()@MaxLength(500)notes?:string;}
class MaterialLineDto{@IsString()materialId:string;@IsQuantity()quantity:string;@IsOptional()@IsString()locationId?:string;@IsOptional()@IsString()batchId?:string;}
class MaterialActionDto{@IsOptional()@IsString()warehouseId?:string;@IsArray()@ArrayMinSize(1)@ValidateNested({each:true})@Type(()=>MaterialLineDto)lines:MaterialLineDto[];@IsOptional()@IsString()@MaxLength(500)notes?:string;}
class CompleteDto{@IsOptional()@IsString()warehouseId?:string;@IsQuantity()quantity:string;@IsOptional()@IsString()locationId?:string;@IsOptional()@IsString()batchId?:string;@IsOptional()@IsString()@MaxLength(500)notes?:string;}
class CancelDto{@IsOptional()@IsString()@MaxLength(500)reason?:string;}

@ApiTags('生产任务') @Controller('production-orders')
export class ProductionController{
  constructor(private readonly service:ProductionService){}
  @Permissions('production.view')@Get()list(@Query()q:any){return this.service.list(q);}@Permissions('production.view')@Get(':id')get(@Param('id')id:string){return this.service.get(id);}@Permissions('production.view')@Get(':id/shortages')shortages(@Param('id')id:string){return this.service.shortages(id);}
  @Permissions('production.manage')@Post()create(@Body()dto:CreateOrderDto,@CurrentUser()u:AuthUser){return this.service.create(dto,u.id);}
  @Permissions('production.manage')@Patch(':id')update(@Param('id')id:string,@Body()dto:UpdateOrderDto,@CurrentUser()u:AuthUser){return this.service.update(id,dto,u.id);}
  @Permissions('production.manage')@Post(':id/release')release(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.release(id,u.id);}
  @Permissions('production.issue')@Post(':id/issue')issue(@Param('id')id:string,@Body()dto:MaterialActionDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.issue(id,dto,key,u.id);}
  @Permissions('production.issue')@Post(':id/return')returnMaterial(@Param('id')id:string,@Body()dto:MaterialActionDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.returnMaterial(id,dto,key,u.id);}
  @Permissions('production.complete')@Post(':id/complete')complete(@Param('id')id:string,@Body()dto:CompleteDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.complete(id,dto,key,u.id);}
  @Permissions('production.manage')@Post(':id/cancel')cancel(@Param('id')id:string,@Body()dto:CancelDto,@CurrentUser()u:AuthUser){return this.service.cancel(id,dto.reason,u.id);}
}
