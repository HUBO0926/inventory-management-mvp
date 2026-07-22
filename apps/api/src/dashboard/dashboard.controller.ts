import { Controller, Get, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';
import { DashboardService } from './dashboard.service';

class CockpitQueryDto {
  @ApiPropertyOptional({ enum: [7, 14, 30], default: 14 })
  @Transform(({ value }) => Number(value ?? 14))
  @IsIn([7, 14, 30], { message: 'days 只允许 7、14 或 30' })
  days = 14;
}

@ApiTags('驾驶舱')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  summary() {
    return this.dashboard.summary();
  }

  @Get('cockpit')
  cockpit(@Query() query: CockpitQueryDto) {
    return this.dashboard.cockpit(query.days);
  }
}
