import { Controller, Get, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { DashboardService } from './dashboard.service';
import { WorkbenchService } from './workbench.service';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';

class CockpitQueryDto {
  @ApiPropertyOptional({ enum: [7, 14, 30], default: 14 })
  @Transform(({ value }) => Number(value ?? 14))
  @IsIn([7, 14, 30], { message: 'days 只允许 7、14 或 30' })
  days = 14;
}

class IntegratedCockpitQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4', { message: 'warehouseId 必须是有效 UUID' })
  warehouseId?: string;

  @ApiPropertyOptional({ enum: ['ALL', 'RAW', 'FG', 'DEFECTIVE'], default: 'ALL' })
  @IsOptional()
  @IsIn(['ALL', 'RAW', 'FG', 'DEFECTIVE'])
  inventoryType = 'ALL';

  @ApiPropertyOptional({ enum: ['TODAY', '7D', '30D'], default: '7D' })
  @IsOptional()
  @IsIn(['TODAY', '7D', '30D'])
  period = '7D';

  @ApiPropertyOptional({
    enum: ['ALL', 'DRAFT', 'RELEASED', 'AWAITING_ISSUE', 'IN_PROGRESS', 'AWAITING_COMPLETION', 'COMPLETED', 'CLOSED', 'CANCELLED'],
    default: 'ALL',
  })
  @IsOptional()
  @IsIn(['ALL', 'DRAFT', 'RELEASED', 'AWAITING_ISSUE', 'IN_PROGRESS', 'AWAITING_COMPLETION', 'COMPLETED', 'CLOSED', 'CANCELLED'])
  productionStatus = 'ALL';

  @ApiPropertyOptional({ description: '物料、成品、任务或单据关键字' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: ['ALL', 'NORMAL', 'LOW', 'ZERO', 'LOCKED', 'DEFECTIVE'], default: 'ALL' })
  @IsOptional()
  @IsIn(['ALL', 'NORMAL', 'LOW', 'ZERO', 'LOCKED', 'DEFECTIVE'])
  inventoryStatus = 'ALL';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  rawPage = 1;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  finishedPage = 1;

  @ApiPropertyOptional({ default: 5, minimum: 1, maximum: 20 })
  @Transform(({ value }) => Number(value ?? 5))
  @IsInt()
  @Min(1)
  @Max(20)
  pageSize = 5;
}

@ApiTags('驾驶舱')
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly workbench: WorkbenchService,
  ) {}

  @Get('summary')
  summary() { return this.dashboard.summary(); }

  @Get('cockpit')
  cockpit(@Query() query: CockpitQueryDto) { return this.dashboard.cockpit(query.days); }

  @Get('integrated-cockpit')
  integratedCockpit(@Query() query: IntegratedCockpitQueryDto, @CurrentUser() user: AuthUser) {
    return this.dashboard.integratedCockpit(query, user);
  }

  @Get('workbench/overview')
  workbenchOverview() { return this.workbench.overview(); }

  @Get('workbench/todos')
  workbenchTodos(@CurrentUser() u: AuthUser) { return this.workbench.todos(u.id); }

  @Get('workbench/todos/all')
  workbenchTodosAll() { return this.workbench.todosAll(); }
}
