import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

import { WorkbenchService } from './workbench.service';

@Module({ controllers: [DashboardController], providers: [DashboardService, WorkbenchService] })
export class DashboardModule {}
