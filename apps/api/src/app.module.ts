import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { CoreModule } from './core.module.js';
import { EntitiesController } from './entities/entities.controller.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';

@Module({
  imports: [CoreModule, AuthModule],
  controllers: [HealthController, MeController, EntitiesController],
})
export class AppModule {}
