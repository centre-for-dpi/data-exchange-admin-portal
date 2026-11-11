import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [CoreModule],
  controllers: [HealthController],
})
export class AppModule {}
