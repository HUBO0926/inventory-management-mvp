import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { ApprovalsService } from './approvals.service';

class RejectDto { @IsString() @MaxLength(500) reason!:string; @IsOptional() @IsString() @MaxLength(50) reasonCode?:string; }
class BatchRejectDto extends RejectDto { @IsArray() @ArrayMinSize(1) @IsString({each:true}) documentIds!:string[]; }
class ApproveDto { @IsOptional() @IsArray() receiptAllocations?:any[]; }
const ctx=(r:any)=>({requestId:r.requestId,ip:r.ip||r.socket?.remoteAddress});
@ApiTags('审核中心') @Controller('approvals') export class ApprovalsController {
  constructor(private readonly service:ApprovalsService) {}
  @Permissions('approval.statistics') @Get('statistics') statistics(@CurrentUser()u:AuthUser){return this.service.statistics(u);}
  @Permissions('approval.view-own') @Get() list(@Query()q:any,@CurrentUser()u:AuthUser){return this.service.list(q,u);}
  @Permissions('approval.view-history') @Get(':documentId/history') history(@Param('documentId')id:string,@CurrentUser()u:AuthUser){return this.service.history(id,u);}
  @Permissions('approval.view-own') @Get(':documentId') detail(@Param('documentId')id:string,@CurrentUser()u:AuthUser){return this.service.detail(id,u);}
  @Permissions('approval.approve') @Post(':documentId/approve') approve(@Param('documentId')id:string,@Body()dto:ApproveDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser,@Req()r:any){return this.service.approve(id,dto,key,u,ctx(r));}
  @Permissions('approval.reject') @Post(':documentId/reject') reject(@Param('documentId')id:string,@Body()dto:RejectDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser,@Req()r:any){return this.service.reject(id,dto,key,u,ctx(r));}
  @Permissions('approval.reject') @Post('batch-reject') batchReject(@Body()dto:BatchRejectDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser,@Req()r:any){return this.service.batchReject(dto.documentIds,dto.reason,key,u,ctx(r));}
}
