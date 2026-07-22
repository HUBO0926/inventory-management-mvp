import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

@ApiTags('仓库')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly db: DataSource) {}
  @Get() list() { return this.db.query(`SELECT id,warehouse_code "warehouseCode",name,warehouse_type "warehouseType",status FROM warehouses ORDER BY warehouse_code`); }
}
