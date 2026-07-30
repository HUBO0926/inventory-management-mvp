import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { IsQuantity } from '../common/validation';
import { ApprovalsService } from './approvals.service';

class RejectDto { @IsString() @MaxLength(500) reason!:string; @IsOptional() @IsString() @MaxLength(50) reasonCode?:string; }
class BatchRejectDto extends RejectDto { @IsArray() @ArrayMinSize(1) @IsString({each:true}) documentIds!:string[]; }
class ReceiptAllocationDto {
  @IsString() documentLineId!:string;
  @IsIn(['NORMAL','DEFECTIVE']) disposition!:string;
  @IsString() warehouseId!:string;
  @IsString() locationId!:string;
  @IsQuantity() quantity!:string;
  @IsOptional() @IsString() batchId?:string;
  @IsOptional() @IsString() @MaxLength(500) defectReason?:string;
}
class ApproveDto { @IsOptional() @IsArray() @ValidateNested({each:true}) @Type(()=>ReceiptAllocationDto) receiptAllocations?:ReceiptAllocationDto[]; }
class ProcessDefectiveDto {
  @IsIn(['RETURN','REPAIR_RESTOCK','RETURN_PRODUCTION']) action!:string;
  @IsQuantity() quantity!:string;
  @IsString() @IsNotEmpty() @MaxLength(500) reason!:string;
  @IsOptional() @IsString() targetWarehouseId?:string;
  @IsOptional() @IsString() targetLocationId?:string;
  @IsOptional() @IsString() productionOrderId?:string;
}
const ctx=(r:any)=>({requestId:r.requestId,ip:r.ip||r.socket?.remoteAddress});
@ApiTags('审核中心') @Controller('approvals') export class ApprovalsController {
  constructor(private readonly service:ApprovalsService) {}
  @Permissions('approval.statistics') @Get('statistics') statistics(@CurrentUser()u:AuthUser){return this.service.statistics(u);}
  @Permissions('approval.view-own') @Get() list(@Query()q:any,@CurrentUser()u:AuthUser){return this.service.list(q,u);}
  @Permissions('approval.defective.view') @Get('defective-items') defectiveItems(@Query()q:any){return this.service.defectiveItems(q);}
  @Permissions('approval.defective.view') @Get('defective-records') defectiveRecords(@Query()q:any){return this.service.defectiveRecords(q);}
  @Permissions('approval.defective.process') @Post('defective-items/:lotId/process') processDefective(@Param('lotId')id:string,@Body()dto:ProcessDefectiveDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.processDefective(id,dto,key,u);}
  @Permissions('approval.view-history') @Get(':documentId/history') history(@Param('documentId')id:string,@CurrentUser()u:AuthUser){return this.service.history(id,u);}
  @Permissions('approval.view-own') @Get(':documentId') detail(@Param('documentId')id:string,@CurrentUser()u:AuthUser){return this.service.detail(id,u);}
  @Permissions('approval.approve') @Post(':documentId/approve') approve(@Param('documentId')id:string,@Body()dto:ApproveDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser,@Req()r:any){return this.service.approve(id,dto,key,u,ctx(r));}
  @Permissions('approval.reject') @Post(':documentId/reject') reject(@Param('documentId')id:string,@Body()dto:RejectDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser,@Req()r:any){return this.service.reject(id,dto,key,u,ctx(r));}
  @Permissions('approval.reject') @Post('batch-reject') batchReject(@Body()dto:BatchRejectDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser,@Req()r:any){return this.service.batchReject(dto.documentIds,dto.reason,key,u,ctx(r));}
}
