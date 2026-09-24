import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser, DocumentType } from '../common/constants';
import { IsQuantity } from '../common/validation';
import { StockDocumentsService } from './stock-documents.service';

class StockLineDto { @IsString() itemId:string; @IsQuantity() quantity:string; @IsOptional() @IsString() locationId?:string;@IsOptional() @IsString() batchId?:string; @IsOptional() @IsString() @MaxLength(80) batchNo?:string; @IsOptional() @IsString() targetWarehouseId?:string; @IsOptional() @IsString() targetLocationId?:string; @IsOptional() @IsString() targetBatchId?:string; @IsOptional() @IsString() @MaxLength(300) notes?:string; }
class StockDocumentDto { @IsArray() @ArrayMinSize(1) @ValidateNested({each:true}) @Type(()=>StockLineDto) lines:StockLineDto[];@IsOptional()@IsString()warehouseId?:string; @IsOptional() @IsString() @MaxLength(500) notes?:string; }
class VoidDto { @IsOptional() @IsString() @MaxLength(500) reason?:string; }
class AdjustmentLineDto{@IsString()itemId:string;@IsString()locationId:string;@IsOptional()@IsString()batchId?:string;@IsString()adjustmentQty:string;@IsOptional()@IsString()@MaxLength(300)notes?:string}
class AdjustmentDto{@IsString()warehouseId:string;@IsArray()@ArrayMinSize(1)@ValidateNested({each:true})@Type(()=>AdjustmentLineDto)lines:AdjustmentLineDto[];@IsOptional()@IsString()@MaxLength(500)notes?:string}
class ItemLocationInventoryQueryDto {
  @IsString() warehouseId: string;
  @IsString() itemId: string;
  @IsIn(['INBOUND', 'OUTBOUND', 'MOVE_SOURCE', 'MOVE_TARGET']) purpose: 'INBOUND' | 'OUTBOUND' | 'MOVE_SOURCE' | 'MOVE_TARGET';
}
class SourceItemOptionsQueryDto {
  @IsString() warehouseId: string;
  @IsIn(['OUTBOUND', 'MOVE_SOURCE']) purpose: 'OUTBOUND' | 'MOVE_SOURCE';
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
}
class SourceDistributionQueryDto { @IsString() itemId:string; @IsOptional() @IsString() warehouseId?:string; @IsOptional() @IsString() zoneId?:string; @IsOptional() @IsString() locationId?:string; }
class FinishedInboundItemQueryDto { @IsString() itemId:string; @IsOptional() @IsString() suggestedLocationId?:string; }
class FinishedInboundLocationTreeQueryDto extends FinishedInboundItemQueryDto {
  @IsOptional() @IsString() @MaxLength(100) keyword?:string;
  @IsOptional() @IsIn(['ALL','NORMAL','AVAILABLE_CAPACITY','EMPTY']) filter?:'ALL'|'NORMAL'|'AVAILABLE_CAPACITY'|'EMPTY';
  @IsOptional() @IsIn(['ROOT','ZONE','LOCATION','SEARCH']) level?:'ROOT'|'ZONE'|'LOCATION'|'SEARCH';
  @IsOptional() @IsString() warehouseId?:string;
  @IsOptional() @IsString() zoneId?:string;
}
class TargetLocationTreeQueryDto extends FinishedInboundLocationTreeQueryDto { @IsOptional() @IsString() locationId?:string; @IsOptional() @IsString() excludeWarehouseId?:string; @IsOptional() @IsString() excludeLocationId?:string; }
class StockCheckLineDto { @IsString() locationId:string; @IsString() itemId:string; @IsOptional() @IsString() batchId?:string; @IsQuantity(true) countedQty:string; @IsOptional() @IsString() @MaxLength(300) notes?:string; }
class StockCheckDto { @IsString() warehouseId:string; @IsArray() @ArrayMinSize(1) @ValidateNested({each:true}) @Type(()=>StockCheckLineDto) lines:StockCheckLineDto[]; @IsOptional() @IsString() @MaxLength(500) notes?:string; }
class StockCheckCandidatesQueryDto { @IsString() warehouseId:string; @IsOptional() @IsString() zoneId?:string; @IsOptional() @IsString() locationId?:string; @IsOptional() @IsString() itemId?:string; }

@ApiTags('库存单据') @Controller('stock-documents')
export class StockDocumentsController{
  constructor(private readonly service:StockDocumentsService){}
  @Permissions('stock.view') @Get() list(@Query()q:any,@CurrentUser()u:AuthUser){return this.service.list(q,u);}
  @Permissions('stock.view') @Get('export') async export(@Query()q:any,@Res()response:any,@CurrentUser()u:AuthUser){const csv=await this.service.exportCsv(q,u);response.setHeader('Content-Type','text/csv; charset=utf-8');response.setHeader('Content-Disposition','attachment; filename="stock-documents.csv"');response.send(csv);}
  @Permissions('stock.view') @Get('source-item-options') sourceItemOptions(@Query()q:SourceItemOptionsQueryDto,@CurrentUser()u:AuthUser){return this.service.sourceItemOptions(q,u);}
  @Permissions('stock.view') @Get('source-distribution') sourceDistribution(@Query()q:SourceDistributionQueryDto,@CurrentUser()u:AuthUser){return this.service.sourceItemDistribution(q.itemId,u,q);}
  @Permissions('stock.view') @Get('item-location-inventory') itemLocationInventory(@Query() q: ItemLocationInventoryQueryDto,@CurrentUser()u:AuthUser) { return this.service.itemLocationInventory(q,u); }
  @Permissions('stock.create') @Get('finished-inbound/item-distribution') finishedInboundDistribution(@Query()q:FinishedInboundItemQueryDto,@CurrentUser()u:AuthUser){return this.service.finishedInboundDistribution(q.itemId,u,q.suggestedLocationId);}
  @Permissions('stock.create') @Get('finished-inbound/location-tree') finishedInboundLocationTree(@Query()q:FinishedInboundLocationTreeQueryDto,@CurrentUser()u:AuthUser){return this.service.finishedInboundLocationTree(q,u);}
  @Permissions('stock.view') @Get('target-location-tree') targetLocationTree(@Query()q:TargetLocationTreeQueryDto,@CurrentUser()u:AuthUser){return this.service.targetLocationTree(q,u);}
  @Permissions('stock.view') @Get(':id') get(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.get(id,u);}
  @Permissions('stock.create') @Post('material-inbound') inbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.MATERIAL_INBOUND,dto,u);}
  @Permissions('stock.create') @Post('finished-inbound') finishedInbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.FINISHED_INBOUND,dto,u);}
  @Permissions('stock.create') @Post('finished-outbound') outbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.FINISHED_OUTBOUND,dto,u);}
  @Permissions('stock.adjust') @Post('inventory-adjustment') adjustment(@Body()dto:AdjustmentDto,@CurrentUser()u:AuthUser){return this.service.createAdjustment(dto,u);}
  @Permissions('stock.move') @Post('move') move(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.createMove(dto,u);}
  @Permissions('stock.create') @Post('allocation-preview') allocationPreview(@Body()dto:any,@CurrentUser()u:AuthUser){return this.service.allocationPreview(dto,u);}
  @Permissions('stock.count') @Get('stock-check-candidates') stockCheckCandidates(@Query()q:StockCheckCandidatesQueryDto,@CurrentUser()u:AuthUser){return this.service.stockCheckCandidates(q,u);}
  @Permissions('stock.count') @Post('stock-check') stockCheck(@Body()dto:StockCheckDto,@CurrentUser()u:AuthUser){return this.service.createStockCheck(dto,u);}
  @Permissions('stock.count') @Patch(':id/stock-check') updateStockCheck(@Param('id')id:string,@Body()dto:StockCheckDto,@CurrentUser()u:AuthUser){return this.service.updateStockCheck(id,dto,u);}
  @Permissions('stock.edit') @Patch(':id') update(@Param('id')id:string,@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.update(id,dto,u);}
  @Permissions('stock.edit') @Delete(':id') remove(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.remove(id,u);}
  @Permissions('stock.submit') @Post(':id/submit') submit(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.submit(id,u);}
  @Permissions('stock.withdraw') @Post(':id/withdraw') withdraw(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.withdraw(id,u);}
  @Permissions('stock.edit') @Post(':id/cancel') cancel(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.cancel(id,u);}
  @Permissions('stock.void') @Post(':id/void') void(@Param('id')id:string,@Body()dto:VoidDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.void(id,dto.reason,key,u);}
}
