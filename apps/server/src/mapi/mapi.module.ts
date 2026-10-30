import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../modules/settings/settings.module';
import { MapiGateway } from './mapi.gateway';
import { RateLimiterService } from './rate-limiter.service';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [SettingsModule],
  providers: [RateLimiterService, TokenService, MapiGateway],
  exports: [RateLimiterService, TokenService, MapiGateway],
})
export class MapiModule {}
