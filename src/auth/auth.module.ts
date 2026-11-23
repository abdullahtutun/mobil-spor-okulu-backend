import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordHasher } from './password/password-hasher';
import { LoginRateLimiter } from './rate-limit/login-rate-limiter';
import { JwtVerifier } from './request/jwt-verifier.service';
import { RequestAuthGuard } from './request/request-auth.guard';
import { AccessTokenIssuer } from './token/tokens';

/**
 * S04: gelen token'ın doğrulanması (JwtVerifier, RequestAuthGuard — global,
 * diğer modüller kullanır). S05: şifreyle giriş, refresh token rotasyonu,
 * çıkış, `/auth/user`. S06 sıfırlama/kayıt/davet akışlarını ekler.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    JwtVerifier,
    RequestAuthGuard,
    AuthService,
    AuthRepository,
    PasswordHasher,
    LoginRateLimiter,
    AccessTokenIssuer,
  ],
  exports: [JwtVerifier, RequestAuthGuard, PasswordHasher, AccessTokenIssuer],
})
export class AuthModule {}
