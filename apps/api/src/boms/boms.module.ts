import { Module } from '@nestjs/common';import { BomsController } from './boms.controller';import { BomsService } from './boms.service';
@Module({controllers:[BomsController],providers:[BomsService],exports:[BomsService]}) export class BomsModule {}
