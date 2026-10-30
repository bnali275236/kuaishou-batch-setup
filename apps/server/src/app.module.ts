import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import * as path from 'path';
import { CryptoModule } from './common/crypto.module';
import { PrismaModule } from './prisma/prisma.module';
import { MapiModule } from './mapi/mapi.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AccountModule } from './modules/account/account.module';
import { MaterialModule } from './modules/material/material.module';
import { ManageModule } from './modules/manage/manage.module';
import { OauthModule } from './modules/oauth/oauth.module';
import { PlanModule } from './modules/plan/plan.module';
import { ReportModule } from './modules/report/report.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AccessGuard } from './modules/system/share.guard';
import { SystemModule } from './modules/system/system.module';

@Module({
  imports: [
    // envFilePath 用绝对路径，避免 cwd 不同导致的配置读取失败
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [path.resolve(process.cwd(), '.env'), '.env'],
    }),
    ScheduleModule.forRoot(),
    CryptoModule,
    PrismaModule,
    SettingsModule,
    MapiModule,
    OauthModule,
    AccountModule,
    ReportModule,
    PlanModule,
    MaterialModule,
    ManageModule,
    SystemModule,
    SchedulerModule,
  ],
  providers: [
    // 全局访问守卫：本机请求放行；其他设备需在开启共享后带访问口令。
    // 放在 AppModule 而不是各业务模块，是为了「新增接口默认受保护」——
    // 忘记加守卫的代价是广告账户被同网段的人操作，不能靠人记住。
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
})
export class AppModule {}
