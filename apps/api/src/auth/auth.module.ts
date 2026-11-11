import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { PrincipalService } from './principal.service.js';
import { createTokenVerifier, portalIssuer, TOKEN_VERIFIER } from './token-verifier.js';

@Global()
@Module({
  providers: [
    {
      provide: TOKEN_VERIFIER,
      useFactory: () => createTokenVerifier({ issuer: portalIssuer() }),
    },
    PrincipalService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PrincipalService, TOKEN_VERIFIER],
})
export class AuthModule {}
