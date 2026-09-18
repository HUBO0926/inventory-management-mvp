import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { InventoryReportService } from './inventory-report.service';
import { InventoryService } from './inventory.service';

@ApiTags('库存')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService, private readonly reports: InventoryReportService) {}

  @Permissions('inventory.view')
  @Get('balances')
  balances(@Query() q: any, @CurrentUser() u: AuthUser) { return this.service.balances(q, u); }

  @Permissions('inventory.view')
  @Get('transactions')
  transactions(@Query() q: any, @CurrentUser() u: AuthUser) { return this.service.transactions(q, u); }

  @Permissions('inventory.view')
  @Get('transactions/:id')
  transaction(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.service.transaction(id, u); }

  @Permissions('inventory.export')
  @Get('reports/:type/export')
  async exportReport(@Param('type') type: string, @Query() q: any, @Res() response: any, @CurrentUser() u: AuthUser) {
    const workbook = await this.reports.export(type, q, u);
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${this.reports.name(type)}-${new Date().toISOString().slice(0, 10)}.xlsx`)}`);
    response.send(workbook);
  }

  @Permissions('inventory.report.view')
  @Get('reports/:type')
  report(@Param('type') type: string, @Query() q: any, @CurrentUser() u: AuthUser) { return this.reports.report(type, q, u); }

  @Permissions('inventory.reconcile')
  @Get('reconciliation')
  reconciliation() { return this.service.reconciliation(); }

  @Permissions('inventory.export')
  @Get('export')
  async export(@Query() q: any, @Res() response: any, @CurrentUser() u: AuthUser) {
    const csv = await this.service.exportCsv(q, u);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="inventory-${new Date().toISOString().slice(0, 10)}.csv"`);
    response.send(csv);
  }
}
