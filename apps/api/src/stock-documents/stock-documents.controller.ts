import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser, DocumentType, Role } from '../common/constants';
import { IsQuantity } from '../common/validation';
import { StockDocumentsService } from './stock-documents.service';

class StockLineDto { @IsString() itemId:string; @IsQuantity() quantity:string; @IsOptional() @IsString() @MaxLength(300) notes?:string; }
class StockDocumentDto { @IsArray() @ArrayMinSize(1) @ValidateNested({each:true}) @Type(()=>StockLineDto) lines:StockLineDto[]; @IsOptional() @IsString() @MaxLength(500) notes?:string; }
class VoidDto { @IsOptional() @IsString() @MaxLength(500) reason?:string; }

@ApiTags('库存单据') @Controller('stock-documents')
export class StockDocumentsController{
  constructor(private readonly service:StockDocumentsService){}
  @Get() list(@Query()q:any){return this.service.list(q);}
  @Get(':id') get(@Param('id')id:string){return this.service.get(id);}
  @Roles(Role.ADMIN,Role.WAREHOUSE) @Post('material-inbound') inbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.MATERIAL_INBOUND,dto,u.id);}
  @Roles(Role.ADMIN,Role.WAREHOUSE) @Post('finished-inbound') finishedInbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.FINISHED_INBOUND,dto,u.id);}
  @Roles(Role.ADMIN,Role.WAREHOUSE) @Post('finished-outbound') outbound(@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.create(DocumentType.FINISHED_OUTBOUND,dto,u.id);}
  @Roles(Role.ADMIN,Role.WAREHOUSE) @Patch(':id') update(@Param('id')id:string,@Body()dto:StockDocumentDto,@CurrentUser()u:AuthUser){return this.service.update(id,dto,u.id);}
  @Roles(Role.ADMIN,Role.WAREHOUSE) @Delete(':id') remove(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.remove(id,u.id);}
  @Roles(Role.ADMIN,Role.WAREHOUSE) @Post(':id/post') post(@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.post(id,key,u.id);}
  @Roles(Role.ADMIN,Role.WAREHOUSE) @Post(':id/void') void(@Param('id')id:string,@Body()dto:VoidDto,@Headers('idempotency-key')key:string|undefined,@CurrentUser()u:AuthUser){return this.service.void(id,dto.reason,key,u.id);}
}
