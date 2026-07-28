import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser, EntityStatus } from '../common/constants';
import { IsQuantity } from '../common/validation';
import { BomsService } from './boms.service';

class BomLineDto { @IsString() materialId: string; @IsQuantity() qtyPer: string; }
class BomDto {
  @IsString() finishedGoodId: string;
  @IsString() @MaxLength(30) version: string;
  @IsEnum(EntityStatus) status: EntityStatus;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => BomLineDto) lines: BomLineDto[];
}
class CopyBomDto { @IsString() @MaxLength(30) version:string;@IsOptional()@IsEnum(EntityStatus)status?:EntityStatus; }
class BomStatusDto { @IsEnum(EntityStatus) status:EntityStatus; }

@ApiTags('BOM') @Controller('boms')
export class BomsController {
  constructor(private readonly service: BomsService) {}
  @Permissions('bom.view') @Get() list(@Query() q: any) { return this.service.list(q); }
  @Permissions('bom.view') @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Permissions('bom.manage') @Post() create(@Body() dto: BomDto, @CurrentUser() u: AuthUser) { return this.service.save(null, dto, u.id); }
  @Permissions('bom.manage') @Put(':id') update(@Param('id') id: string, @Body() dto: BomDto, @CurrentUser() u: AuthUser) { return this.service.save(id, dto, u.id); }
  @Permissions('bom.manage') @Post(':id/copy') copy(@Param('id')id:string,@Body()dto:CopyBomDto,@CurrentUser()u:AuthUser){return this.service.copy(id,dto,u.id);}
  @Permissions('bom.manage') @Patch(':id/status') status(@Param('id')id:string,@Body()dto:BomStatusDto,@CurrentUser()u:AuthUser){return this.service.changeStatus(id,dto.status,u.id);}
  @Permissions('bom.delete') @Delete(':id') remove(@Param('id')id:string,@CurrentUser()u:AuthUser){return this.service.remove(id,u.id);}
}
