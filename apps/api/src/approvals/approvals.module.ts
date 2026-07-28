import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { StockDocumentsModule } from '../stock-documents/stock-documents.module';

@Module({ imports:[StockDocumentsModule], controllers:[ApprovalsController], providers:[ApprovalsService] })
export class ApprovalsModule {}
