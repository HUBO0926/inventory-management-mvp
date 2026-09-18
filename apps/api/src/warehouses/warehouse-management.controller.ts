import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { WarehouseManagementService } from './warehouse-management.service';

@ApiTags('仓库管理工作台')
@Controller('warehouse-management')
export class WarehouseManagementController {
  constructor(private readonly service: WarehouseManagementService) {}
  @Get('warehouses') @Permissions('warehouse.capacity.view','inventory.view') warehouses(@CurrentUser() user: AuthUser) { return this.service.warehouses(user); }
  @Get('warehouses/:id/zones') @Permissions('warehouse.capacity.view','inventory.view') zones(@Param('id') id: string,@CurrentUser() user: AuthUser) { return this.service.zones(user,id); }
  @Get('zones/:id/locations') @Permissions('warehouse.capacity.view','inventory.view') locations(@Param('id') id: string,@CurrentUser() user: AuthUser) { return this.service.locations(user,id); }
  @Get('context/:type/:id') @Permissions('warehouse.capacity.view','inventory.view') context(@Param('type') type: 'warehouse'|'zone'|'location',@Param('id') id: string,@CurrentUser() user: AuthUser) { return this.service.context(user,type,id); }
  @Get('locations/:id/materials') @Permissions('warehouse.capacity.view','inventory.view') materials(@Param('id') id: string,@Query() q: any,@CurrentUser() user: AuthUser) { return this.service.materials(user,id,q); }
  @Get('search') @Permissions('warehouse.capacity.view','inventory.view') search(@Query('keyword') keyword: string,@CurrentUser() user: AuthUser) { return this.service.search(user,keyword); }
  @Get('activity') @Permissions('warehouse.capacity.view','inventory.view') activity(@Query() q: any,@CurrentUser() user: AuthUser) { return this.service.activity(user,q); }
  @Put('locations/:locationId/item-rules/:itemId') @Permissions('warehouse.capacity.manage') saveRule(@Param('locationId') locationId: string,@Param('itemId') itemId: string,@Body() dto: any,@CurrentUser() user: AuthUser) { return this.service.saveRule(user,locationId,itemId,dto); }
  @Delete('locations/:locationId/item-rules/:itemId') @Permissions('warehouse.capacity.manage') removeRule(@Param('locationId') locationId: string,@Param('itemId') itemId: string,@CurrentUser() user: AuthUser) { return this.service.removeRule(user,locationId,itemId); }
  @Post('operation-locks') @Permissions('stock.freeze') lock(@Body() dto: any,@CurrentUser() user: AuthUser) { return this.service.lock(user,dto); }
  @Post('operation-locks/:id/release') @Permissions('stock.freeze') unlock(@Param('id') id: string,@CurrentUser() user: AuthUser) { return this.service.unlock(user,id); }
}
