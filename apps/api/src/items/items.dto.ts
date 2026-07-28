import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EntityStatus, ItemType } from '../common/constants';
import { IsQuantity } from '../common/validation';

export const externalItemTypes = ['RAW_MATERIAL', 'MATERIAL', 'FINISHED_GOOD'] as const;
export type ExternalItemType = typeof externalItemTypes[number];

export class ItemQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @IsEnum(EntityStatus) status?: EntityStatus;
  @IsOptional() @IsEnum(ItemType) itemType?: ItemType;
  @IsOptional() @IsString() @Matches(/^(RAW_MATERIAL|MATERIAL|FINISHED_GOOD)$/) type?: ExternalItemType;
  @IsOptional() @IsUUID() categoryId?: string;
}

export class CreateItemDto {
  @IsOptional() @IsString() @MaxLength(50) itemCode?: string;
  @IsOptional() @IsString() @MaxLength(50) code?: string;
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsOptional() @IsEnum(ItemType) itemType?: ItemType;
  @IsOptional() @IsString() @Matches(/^(RAW_MATERIAL|MATERIAL|FINISHED_GOOD)$/) type?: ExternalItemType;
  @IsOptional() @IsUUID() unitId?: string;
  @IsOptional() @IsString() @MaxLength(50) unit?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsQuantity(true) minimumStock?: string;
  @IsOptional() @IsQuantity(true) safetyStock?: string;
  @IsOptional() @IsString() @MaxLength(100) brand?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(500) spec?: string;
  @IsOptional() @IsString() @MaxLength(500) specification?: string;
  @IsOptional() @IsUUID() defaultWarehouseId?: string;
  @IsOptional() @IsBoolean() enableBatch?: boolean;
  @IsOptional() @IsEnum(EntityStatus) status?: EntityStatus;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

export class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(50) itemCode?: string;
  @IsOptional() @IsString() @MaxLength(50) code?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsEnum(ItemType) itemType?: ItemType;
  @IsOptional() @IsString() @Matches(/^(RAW_MATERIAL|MATERIAL|FINISHED_GOOD)$/) type?: ExternalItemType;
  @IsOptional() @IsUUID() unitId?: string;
  @IsOptional() @IsString() @MaxLength(50) unit?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsQuantity(true) minimumStock?: string;
  @IsOptional() @IsQuantity(true) safetyStock?: string;
  @IsOptional() @IsString() @MaxLength(100) brand?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(500) spec?: string;
  @IsOptional() @IsString() @MaxLength(500) specification?: string;
  @IsOptional() @IsUUID() defaultWarehouseId?: string;
  @IsOptional() @IsBoolean() enableBatch?: boolean;
  @IsOptional() @IsEnum(EntityStatus) status?: EntityStatus;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}
