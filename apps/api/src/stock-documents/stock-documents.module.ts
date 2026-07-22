import { Module } from '@nestjs/common';import { StockDocumentsController } from './stock-documents.controller';import { StockDocumentsService } from './stock-documents.service';
@Module({controllers:[StockDocumentsController],providers:[StockDocumentsService],exports:[StockDocumentsService]})export class StockDocumentsModule{}
