import { Module } from '@nestjs/common';
import { MapiModule } from '../../mapi/mapi.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AppCenterController } from './appcenter.controller';
import { AppCenterService } from './appcenter.service';

@Module({
  imports: [PrismaModule, MapiModule],
  controllers: [AppCenterController],
  providers: [AppCenterService],
  exports: [AppCenterService],
})
export class AppCenterModule {}
