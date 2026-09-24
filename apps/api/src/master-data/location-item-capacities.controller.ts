import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { BusinessException } from '../common/business.exception';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { WarehouseAccessService } from '../warehouses/warehouse-access.service';
import { WarehouseStateService } from '../warehouses/warehouse-state.service';
import { WarehouseManagementService } from '../warehouses/warehouse-management.service';

class CapacityDto {
  @IsString() locationId: string;
  @IsString() itemId: string;
  @IsString() capacity: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

@Controller('location-item-capacities')
export class LocationItemCapacitiesController {
  constructor(private readonly db: DataSource, private readonly access: WarehouseAccessService, private readonly state: WarehouseStateService, private readonly operations: WarehouseManagementService) {}

  @Permissions('warehouse.capacity.view')
  @Get()
  async list(@Query() q: any, @CurrentUser() u: AuthUser) {
    const scope = q.warehouseId ? [q.warehouseId] : await this.access.getAccessibleWarehouseIds(u);
    if (q.warehouseId) await this.access.assertWarehouse(u, q.warehouseId);
    const params: any[] = [scope];
    const where: string[] = [];
    const add = (value: any, sql: string) => {
      if (!value) return;
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    add(q.warehouseId, 'l.warehouse_id=?');
    add(q.locationId, 'c.location_id=?');
    add(q.itemId, 'c.item_id=?');
    where.unshift(`($1::uuid[] IS NULL OR l.warehouse_id=ANY($1::uuid[]))`);
    const clause = `WHERE ${where.join(' AND ')}`;
    return this.db.query(`
      SELECT c.location_id "locationId",c.item_id "itemId",c.capacity::text capacity,c.notes,
        w.id "warehouseId",w.warehouse_code "warehouseCode",z.id "zoneId",z.code "zoneCode",
        l.code "locationCode",l.code "locationDisplayName",l.name "locationName",NULLIF(z.actual_location,'未填写') "actualPosition",i.item_code "itemCode",i.name "itemName",i.unit
      FROM location_item_capacities c
      JOIN warehouse_locations l ON l.id=c.location_id
      JOIN warehouse_zones z ON z.id=l.zone_id
      JOIN warehouses w ON w.id=l.warehouse_id
      JOIN items i ON i.id=c.item_id
      ${clause}
      ORDER BY w.warehouse_code,z.code,l.code,i.item_code`, params);
  }

  @Permissions('warehouse.capacity.manage')
  @Put()
  async save(@Body() dto: CapacityDto, @CurrentUser() u: AuthUser) {
    const capacity = new Decimal(dto.capacity);
    if (!capacity.isFinite() || !capacity.isInteger() || !capacity.isPositive()) {
      throw new BusinessException('VALIDATION_ERROR', '库位物料容量必须是大于零的整数');
    }
    const [location] = await this.db.query(`SELECT l.id,l.warehouse_id "warehouseId",w.warehouse_type "warehouseType" FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=$1 AND l.status='ACTIVE' AND l.is_archived=false`, [dto.locationId]);
    if (!location) throw new BusinessException('VALIDATION_ERROR', '库位不存在、已停用或已归档');
    await this.access.assertWarehouse(u, location.warehouseId);
    const [item] = await this.db.query(`SELECT id,item_type "itemType" FROM items WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [dto.itemId]);
    if (!item) throw new BusinessException('VALIDATION_ERROR', '物料不存在或已停用');
    if ((location.warehouseType === 'RAW' && item.itemType !== 'MATERIAL') || (location.warehouseType === 'FG' && item.itemType !== 'FINISHED_GOOD')) throw new BusinessException('VALIDATION_ERROR', '该仓库只能配置对应类型的物料容量');
    const [row] = await this.db.query(`
      INSERT INTO location_item_capacities(location_id,item_id,capacity,notes)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(location_id,item_id) DO UPDATE SET capacity=EXCLUDED.capacity,notes=EXCLUDED.notes,updated_at=now()
      RETURNING location_id "locationId",item_id "itemId",capacity::text capacity,notes`,
      [dto.locationId, dto.itemId, capacity.toFixed(0), dto.notes?.trim() || null],
    );
    await this.operations.refreshInventoryAlerts(this.db as any,[location.warehouseId]);
    return row;
  }

  @Permissions('warehouse.capacity.manage')
  @Delete(':locationId/:itemId')
  async remove(@Param('locationId') locationId: string, @Param('itemId') itemId: string, @CurrentUser() u: AuthUser) {
    const [location] = await this.db.query(`SELECT warehouse_id "warehouseId" FROM warehouse_locations WHERE id=$1`, [locationId]);
    if (!location) throw new BusinessException('NOT_FOUND', '库位不存在');
    await this.access.assertWarehouse(u, location.warehouseId);
    const rows = await this.db.query(`DELETE FROM location_item_capacities WHERE location_id=$1 AND item_id=$2 RETURNING location_id "locationId",item_id "itemId"`, [locationId, itemId]);
    if (!rows.length) throw new BusinessException('NOT_FOUND', '库位物料容量配置不存在');
    await this.operations.refreshInventoryAlerts(this.db as any,[location.warehouseId]);
    return rows[0];
  }

  @Permissions('warehouse.capacity.view')
  @Get('workspace/tree')
  tree(@Query('warehouseId') warehouseId: string | undefined, @CurrentUser() u: AuthUser) { return this.state.tree(u, warehouseId); }

  @Permissions('warehouse.capacity.view')
  @Get('workspace/location/:locationId')
  detail(@Param('locationId') locationId: string, @CurrentUser() u: AuthUser) { return this.state.locationDetail(u, locationId); }

  @Permissions('warehouse.capacity.view')
  @Get('item-options')
  async itemOptions(@Query('warehouseId') warehouseId: string, @Query('keyword') keyword: string | undefined, @CurrentUser() u: AuthUser) {
    if (!warehouseId) throw new BusinessException('VALIDATION_ERROR', '请选择仓库');
    await this.access.assertWarehouse(u, warehouseId);
    const [warehouse] = await this.db.query(`SELECT warehouse_type "warehouseType" FROM warehouses WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL`, [warehouseId]);
    if (!warehouse) throw new BusinessException('NOT_FOUND', '仓库不存在或已停用');
    const types = warehouse.warehouseType === 'RAW' ? ['MATERIAL'] : warehouse.warehouseType === 'FG' ? ['FINISHED_GOOD'] : ['MATERIAL', 'FINISHED_GOOD'];
    const rows = await this.db.query(`SELECT id,item_code "itemCode",name,model,unit,item_type "itemType" FROM items WHERE status='ACTIVE' AND deleted_at IS NULL AND item_type=ANY($1::varchar[]) AND ($2::text IS NULL OR item_code ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%') ORDER BY item_code`, [types, keyword?.trim() || null]);
    return { items: rows };
  }
}
