import { Controller, Get, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';
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

  @Get('workbench/overview')
  workbenchOverview() { return this.workbench.overview(); }

  @Get('workbench/todos')
  workbenchTodos(@CurrentUser() u: AuthUser) { return this.workbench.todos(u.id); }

  @Get('workbench/todos/all')
  workbenchTodosAll() { return this.workbench.todosAll(); }
}
