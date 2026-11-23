import { Global, Module } from '@nestjs/common';
import { JwtVerifier } from './request/jwt-verifier.service';
import { RequestAuthGuard } from './request/request-auth.guard';

/**
 * S04: yalnızca gelen token'ın doğrulanması. Giriş, token üretimi, refresh
 * ve çıkış S05'te buraya eklenir.
 */
@Global()
@Module({
  providers: [JwtVerifier, RequestAuthGuard],
  exports: [JwtVerifier, RequestAuthGuard],
})
export class AuthModule {}
