import { Module } from '@nestjs/common';
import { AsyncReportService } from './async-report.service';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { ReportSyncScheduler } from './report.scheduler';

@Module({
  controllers: [ReportController],
  providers: [ReportService, AsyncReportService, ReportSyncScheduler],
  exports: [ReportService, AsyncReportService],
})
export class ReportModule {}
