import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from './auth/auth.decorators';
import { batchInboundEnabled } from './common/release-features';
@Controller('health') export class HealthController { constructor(private readonly db:DataSource){} @Public() @Get() async health(){await this.db.query('SELECT 1');return {status:'ok',features:{batchInbound:batchInboundEnabled()}};} }
