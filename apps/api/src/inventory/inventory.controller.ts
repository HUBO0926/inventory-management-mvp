import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../auth/auth.decorators';
import { InventoryReportService } from './inventory-report.service';
import { InventoryService } from './inventory.service';

@ApiTags('库存')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService, private readonly reports: InventoryReportService) {}

  @Permissions('inventory.view')
  @Get('balances')
  balances(@Query() q: any) { return this.service.balances(q); }

  @Permissions('inventory.view')
  @Get('transactions')
  transactions(@Query() q: any) { return this.service.transactions(q); }

  @Permissions('inventory.view')
  @Get('transactions/:id')
  transaction(@Param('id') id: string) { return this.service.transaction(id); }

  @Permissions('inventory.export')
  @Get('reports/:type/export')
  async exportReport(@Param('type') type: string, @Query() q: any, @Res() response: any) {
    const workbook = await this.reports.export(type, q);
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${this.reports.name(type)}-${new Date().toISOString().slice(0, 10)}.xlsx`)}`);
    response.send(workbook);
  }

  @Permissions('inventory.report.view')
  @Get('reports/:type')
  report(@Param('type') type: string, @Query() q: any) { return this.reports.report(type, q); }

  @Permissions('inventory.reconcile')
  @Get('reconciliation')
  reconciliation() { return this.service.reconciliation(); }

  @Permissions('inventory.export')
  @Get('export')
  async export(@Query() q: any, @Res() response: any) {
    const csv = await this.service.exportCsv(q);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="inventory-${new Date().toISOString().slice(0, 10)}.csv"`);
    response.send(csv);
  }
}
