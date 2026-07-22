import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser, EntityStatus, Role } from '../common/constants';
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

@ApiTags('BOM') @Controller('boms')
export class BomsController {
  constructor(private readonly service: BomsService) {}
  @Get() list(@Query() q: any) { return this.service.list(q); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Roles(Role.ADMIN) @Post() create(@Body() dto: BomDto, @CurrentUser() u: AuthUser) { return this.service.save(null, dto, u.id); }
  @Roles(Role.ADMIN) @Put(':id') update(@Param('id') id: string, @Body() dto: BomDto, @CurrentUser() u: AuthUser) { return this.service.save(id, dto, u.id); }
}
