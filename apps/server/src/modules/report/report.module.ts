import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module';
import { AsyncReportService } from './async-report.service';
import { CreativeAttrsService } from './creative-attrs.service';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { ReportSyncScheduler } from './report.scheduler';

@Module({
  imports: [PlanModule],
  controllers: [ReportController],
  providers: [ReportService, AsyncReportService, ReportSyncScheduler, CreativeAttrsService],
  exports: [ReportService, AsyncReportService, CreativeAttrsService],
})
export class ReportModule {}
