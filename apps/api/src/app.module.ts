import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, PermissionsGuard, RolesGuard } from './auth/auth.guards';
import { ApiExceptionFilter, ResponseInterceptor } from './common/http';
import { ItemsModule } from './items/items.module';
import { WarehousesModule } from './warehouses/warehouses.module';
import { BomsModule } from './boms/boms.module';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';
import { HealthController } from './health.controller';
import { InventoryModule } from './inventory/inventory.module';
import { StockDocumentsModule } from './stock-documents/stock-documents.module';
import { ProductionModule } from './production/production.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MasterDataModule } from './master-data/master-data.module';
import { SystemModule } from './system/system.module';
import { AuditRequestInterceptor } from './audit/audit-request.interceptor';
import { ApprovalsModule } from './approvals/approvals.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ApprovalWorkflowModule } from './approvals/approval-workflow.module';

@Module({
  imports:[
    TypeOrmModule.forRoot(process.env.DATABASE_URL
      ? { type: 'postgres', url: process.env.DATABASE_URL, synchronize: false, logging: process.env.DB_LOGGING === 'true' }
      : {
          type: 'postgres',
          host: process.env.POSTGRES_HOST || 'localhost',
          port: Number(process.env.POSTGRES_PORT || 5434),
          database: process.env.POSTGRES_DB || 'inventory',
          username: process.env.POSTGRES_USER || 'inventory',
          password: process.env.POSTGRES_PASSWORD || 'inventory_dev',
          synchronize: false,
          logging: process.env.DB_LOGGING === 'true',
        }),
    AuditModule,ApprovalWorkflowModule,AuthModule,UsersModule,ItemsModule,WarehousesModule,BomsModule,InventoryModule,StockDocumentsModule,ProductionModule,DashboardModule,MasterDataModule,SystemModule,ApprovalsModule,NotificationsModule,
  ],
  controllers:[HealthController],
  providers:[
    {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RolesGuard},{provide:APP_GUARD,useClass:PermissionsGuard},
    {provide:APP_INTERCEPTOR,useClass:ResponseInterceptor},{provide:APP_INTERCEPTOR,useClass:AuditRequestInterceptor},{provide:APP_FILTER,useClass:ApiExceptionFilter},
  ],
}) export class AppModule {}
