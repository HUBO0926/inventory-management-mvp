import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Permissions } from '../auth/auth.decorators';
import { EntityStatus, ItemType } from '../common/constants';
import { MasterDataService } from './master-data.service';

class MasterDto {
  @IsString() @MaxLength(50) code:string;
  @IsString() @MinLength(1) @MaxLength(100) name:string;
}
class ZoneDto extends MasterDto{@IsString() warehouseId:string}
class LocationDto extends MasterDto{@IsString() warehouseId:string;@IsString() zoneId:string}
class MasterUpdateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?:string;
  @IsOptional() @IsEnum(EntityStatus) status?:EntityStatus;
  @IsOptional() @IsString() @MaxLength(300) notes?:string;
}
class CategoryQueryDto {
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) page?:number;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(100) pageSize?:number;
  @IsOptional() @IsString() @MaxLength(100) keyword?:string;
  @IsOptional() @IsEnum(EntityStatus) status?:EntityStatus;
  @IsOptional() @IsEnum(ItemType) itemType?:ItemType;
}
class CategoryCreateDto {
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/) code:string;
  @IsString() @MaxLength(100) name:string;
  @IsEnum(ItemType) itemType:ItemType;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(0) @Max(9999) sortOrder?:number;
}
class CategoryUpdateDto {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/) code?:string;
  @IsOptional() @IsString() @MaxLength(100) name?:string;
  @IsOptional() @IsEnum(EntityStatus) status?:EntityStatus;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(0) @Max(9999) sortOrder?:number;
}
class BatchDto {
  @IsString() itemId:string;
  @IsString() @MaxLength(80) batchNo:string;
  @IsOptional() @IsString() @MaxLength(300) notes?:string;
}

@ApiTags('物料分类') @Controller('item-categories')
export class CategoriesController{constructor(private s:MasterDataService){}
  @Permissions('category.view')@Get()list(@Query()q:CategoryQueryDto){return this.s.listCategories(q)}
  @Permissions('category.view')@Get(':id')get(@Param('id')id:string){return this.s.getCategory(id)}
  @Permissions('category.manage')@Post()create(@Body()d:CategoryCreateDto){return this.s.createCategory(d)}
  @Permissions('category.manage')@Patch(':id')update(@Param('id')id:string,@Body()d:CategoryUpdateDto){return this.s.updateCategory(id,d)}
  @Permissions('category.delete')@Delete(':id')remove(@Param('id')id:string){return this.s.removeCategory(id)}
}
@ApiTags('单位') @Controller('units')
export class UnitsController{constructor(private s:MasterDataService){}
  @Permissions('master.view')@Get()list(@Query()q:any){return this.s.list('unit',q)}
  @Permissions('master.view')@Get(':id')get(@Param('id')id:string){return this.s.get('unit',id)}
  @Permissions('master.manage')@Post()create(@Body()d:MasterDto){return this.s.create('unit',d)}
  @Permissions('master.manage')@Patch(':id')update(@Param('id')id:string,@Body()d:MasterUpdateDto){return this.s.update('unit',id,d)}
  @Permissions('master.delete')@Delete(':id')remove(@Param('id')id:string){return this.s.remove('unit',id)}
}
@ApiTags('库区') @Controller('warehouse-zones')
export class ZonesController{constructor(private s:MasterDataService){}
  @Permissions('master.view')@Get()list(@Query()q:any){return this.s.list('zone',{...q,parentId:q.warehouseId})}
  @Permissions('master.manage')@Post()create(@Body()d:ZoneDto){return this.s.create('zone',d)}
  @Permissions('master.manage')@Patch(':id')update(@Param('id')id:string,@Body()d:MasterUpdateDto){return this.s.update('zone',id,d)}
  @Permissions('master.delete')@Delete(':id')remove(@Param('id')id:string){return this.s.remove('zone',id)}
}
@ApiTags('库位') @Controller('warehouse-locations')
export class LocationsController{constructor(private s:MasterDataService){}
  @Permissions('master.view')@Get()list(@Query()q:any){return this.s.list('location',{...q,parentId:q.warehouseId})}
  @Permissions('master.manage')@Post()create(@Body()d:LocationDto){return this.s.create('location',d)}
  @Permissions('master.manage')@Patch(':id')update(@Param('id')id:string,@Body()d:MasterUpdateDto){return this.s.update('location',id,d)}
  @Permissions('master.delete')@Delete(':id')remove(@Param('id')id:string){return this.s.remove('location',id)}
}
@ApiTags('批次') @Controller('batches')
export class BatchesController{constructor(private s:MasterDataService){}
  @Permissions('stock.view')@Get()list(@Query()q:any){return this.s.list('batch',{...q,parentId:q.itemId})}
  @Permissions('stock.create')@Post()create(@Body()d:BatchDto){return this.s.create('batch',d)}
  @Permissions('master.manage')@Patch(':id')update(@Param('id')id:string,@Body()d:MasterUpdateDto){return this.s.update('batch',id,d)}
  @Permissions('master.delete')@Delete(':id')remove(@Param('id')id:string){return this.s.remove('batch',id)}
}
