import { Module } from '@nestjs/common';
import { MapiModule } from '../../mapi/mapi.module';
import { PlanModule } from '../plan/plan.module';
import { ReportModule } from '../report/report.module';
import { ManageController } from './manage.controller';
import { ManageService } from './manage.service';

@Module({
  imports: [MapiModule, PlanModule, ReportModule],
  controllers: [ManageController],
  providers: [ManageService],
  exports: [ManageService],
})
export class ManageModule {}
