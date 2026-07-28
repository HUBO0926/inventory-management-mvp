import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser, DocumentType } from '../common/constants';
import { IsQuantity } from '../common/validation';
import { StockDocumentsService } from './stock-documents.service';

class StockLineDto { @IsString() itemId:string; @IsQuantity() quantity:string; @IsOptional() @IsString() locationId?:string;@IsOptional() @IsString() batchId?:string; @IsOptional() @IsString() targetWarehouseId?:string; @IsOptional() @IsString() targetLocationId?:string; @IsOptional() @IsString() targetBatchId?:string; @IsOptional() @IsString() @MaxLength(300) notes?:string; }
class StockDocumentDto { @IsArray() @ArrayMinSize(1) @ValidateNested({each:true}) @Type(()=>StockLineDto) lines:StockLineDto[];@IsOptional()@IsString()warehouseId?:string; @IsOptional() @IsString() @MaxLength(500) notes?:string; }
class ReceiptAllocationDto { @IsString() documentLineId:string; @IsString() disposition:string; @IsString() warehouseId:string; @IsString() locationId:string; @IsQuantity() quantity:string; @IsOptional() @IsString() batchId?:string; }
class ApproveDto { @IsOptional() @IsArray() @ValidateNested({each:true}) @Type(()=>ReceiptAllocationDto) receiptAllocations?: ReceiptAllocationDto[]; }
class VoidDto { @IsOptional() @IsString() @MaxLength(500) reason?:string; }
class ReasonDto { @IsOptional() @IsString() @MaxLength(500) reason?:string; }
class AdjustmentLineDto{@IsString()itemId:string;@IsString()locationId:string;@IsOptional()@IsString()batchId?:string;@IsString()adjustmentQty:string;@IsOptional()@IsString()@MaxLength(300)notes?:string}
class AdjustmentDto{@IsString()warehouseId:string;@IsArray()@ArrayMinSize(1)@ValidateNested({each:true})@Type(()=>AdjustmentLineDto)lines:AdjustmentLineDto[];@IsOptional()@IsString()@MaxLength(500)notes?:string}

@ApiTags('库存单据') @Controller('stock-documents')
export class StockDocumentsController{
  constructor(private readonly service:StockDocumentsService){}
  @Permissions('stock.view') @Get() list(@Query()q:any){return this.service.list(q);}
  @Permissions('stock.view') @Get('export') async export(@Query()q:any,@Res()response:any){const csv=await this.service.exportCsv(q);response.setHeader('Content-Type','text/csv; charset=utf-8');response.setHeader('Content-Disposition','attachment; filename="stock-documents.csv"');response.send(csv);}
  @Permissions('stock.view') @Get(':id') get(@Param('id')id:string){return this.service.get(id);}
  @Permissions('stock.create') @Post('material-inbound') inbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.MATERIAL_INBOUND,dto,u.id);}
  @Permissions('stock.create') @Post('finished-inbound') finishedInbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.FINISHED_INBOUND,dto,u.id);}
  @Permissions('stock.create') @Post('finished-outbound') outbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.FINISHED_OUTBOUND,dto,u.id);}
  @Permissions('stock.create') @Post('inventory-adjustment') adjustment(@Body()dto:AdjustmentDto,@CurrentUser()u:AuthUser){return this.service.createAdjustment(dto,u.id);}
  @Permissions('stock.create') @Post('move') move(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.createMove(dto,u.id);}
  @Permissions('stock.edit') @Patch(':id') update(@Param('id')id:string,@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.update(id,dto,u.id);}
  @Permissions('stock.edit') @Delete(':id') remove(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.remove(id,u.id);}
  @Permissions('stock.direct_post') @Post(':id/post') post(@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.post(id,key,u.id);}
  @Permissions('stock.submit') @Post(':id/submit') submit(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.submit(id,u.id);}
  @Permissions('stock.withdraw') @Post(':id/withdraw') withdraw(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.withdraw(id,u.id);}
  @Permissions('stock.edit') @Post(':id/cancel') cancel(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.cancel(id,u.id);}
  @Permissions('stock.approve') @Post(':id/approve') approve(@Param('id')id:string,@Body()dto:ApproveDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.approve(id,dto,key,u.id);}
  @Permissions('stock.reject') @Post(':id/reject') reject(@Param('id')id:string,@Body()dto:ReasonDto,@CurrentUser()u:AuthUser){return this.service.reject(id,dto.reason,u.id);}
  @Permissions('stock.void') @Post(':id/void') void(@Param('id')id:string,@Body()dto:VoidDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.void(id,dto.reason,key,u.id);}
}
