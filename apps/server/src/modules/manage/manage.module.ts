import { Module } from '@nestjs/common';
import { MapiModule } from '../../mapi/mapi.module';
import { PlanModule } from '../plan/plan.module';
import { ManageController } from './manage.controller';
import { ManageService } from './manage.service';

@Module({
  imports: [MapiModule, PlanModule],
  controllers: [ManageController],
  providers: [ManageService],
  exports: [ManageService],
})
export class ManageModule {}
