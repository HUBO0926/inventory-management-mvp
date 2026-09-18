import { Global, Module } from '@nestjs/common';
import { WarehousesController } from './warehouses.controller';
import { WarehouseAccessService } from './warehouse-access.service';
import { WarehouseStateService } from './warehouse-state.service';
import { WarehouseManagementController } from './warehouse-management.controller';
import { WarehouseManagementService } from './warehouse-management.service';
@Global()
@Module({ controllers: [WarehousesController, WarehouseManagementController], providers: [WarehouseAccessService, WarehouseStateService, WarehouseManagementService], exports: [WarehouseAccessService, WarehouseStateService, WarehouseManagementService] })
export class WarehousesModule {}
