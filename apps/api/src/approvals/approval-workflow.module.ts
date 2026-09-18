import { Global, Module } from '@nestjs/common';
import { ApprovalWorkflowService } from './approval-workflow.service';
@Global()
@Module({ providers:[ApprovalWorkflowService], exports:[ApprovalWorkflowService] })
export class ApprovalWorkflowModule {}
