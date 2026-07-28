import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { ApprovalHistoryService } from './approval-history.service';

@Global()
@Module({ controllers:[AuditController],providers: [AuditService,ApprovalHistoryService], exports: [AuditService,ApprovalHistoryService] })
export class AuditModule {}
