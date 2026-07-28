import { Module } from '@nestjs/common';
import { BatchesController, CategoriesController, LocationsController, UnitsController, ZonesController } from './master-data.controller';
import { MasterDataService } from './master-data.service';
@Module({controllers:[CategoriesController,UnitsController,ZonesController,LocationsController,BatchesController],providers:[MasterDataService]})
export class MasterDataModule{}
