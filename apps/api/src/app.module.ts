import { Module } from '@nestjs/common';
import { ApisController } from './apis/apis.controller.js';
import { ApisService } from './apis/apis.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { CoreModule } from './core.module.js';
import { EntitiesController } from './entities/entities.controller.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';
import { PurposesController } from './purposes/purposes.controller.js';
import { ReviewsController } from './reviews/reviews.controller.js';
import { ReviewsService } from './reviews/reviews.service.js';

@Module({
  imports: [CoreModule, AuthModule],
  controllers: [
    HealthController,
    MeController,
    EntitiesController,
    PurposesController,
    ApisController,
    ReviewsController,
    CatalogController,
  ],
  providers: [ApisService, ReviewsService, CatalogService],
})
export class AppModule {}
