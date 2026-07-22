import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser, EntityStatus, ItemType, Role } from '../common/constants';
import { IsQuantity } from '../common/validation';
import { ItemsService } from './items.service';

class CreateItemDto {
  @IsString() @MaxLength(50) itemCode: string;
  @IsString() @MaxLength(100) name: string;
  @IsEnum(ItemType) itemType: ItemType;
  @IsString() @MaxLength(20) unit: string;
  @IsOptional() @IsQuantity(true) minimumStock?: string;
}
class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @IsQuantity(true) minimumStock?: string;
  @IsOptional() @IsEnum(EntityStatus) status?: EntityStatus;
}

@ApiTags('物料')
@Controller('items')
export class ItemsController {
  constructor(private readonly service: ItemsService) {}
  @Get() list(@Query() query: any) { return this.service.list(query); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Roles(Role.ADMIN) @Post() create(@Body() dto: CreateItemDto, @CurrentUser() user: AuthUser) { return this.service.create(dto, user.id); }
  @Roles(Role.ADMIN) @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateItemDto, @CurrentUser() user: AuthUser) { return this.service.update(id, dto, user.id); }
}
