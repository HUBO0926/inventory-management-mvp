import { Module } from '@nestjs/common';
import { BatchesController, CategoriesController, LocationsController, UnitsController, ZonesController } from './master-data.controller';
import { MasterDataService } from './master-data.service';
import { LocationItemCapacitiesController } from './location-item-capacities.controller';
@Module({controllers:[CategoriesController,UnitsController,ZonesController,LocationsController,BatchesController,LocationItemCapacitiesController],providers:[MasterDataService]})
export class MasterDataModule{}
