import { Global, Module } from '@nestjs/common';
import { AuthAdminService } from './admin/auth-admin.service';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthFlowsController } from './flows/auth-flows.controller';
import { AuthFlowsRepository } from './flows/auth-flows.repository';
import { AuthFlowsService } from './flows/auth-flows.service';
import { OtpHasher } from './otp/otp-codes';
import { PasswordHasher } from './password/password-hasher';
import { EmailRateLimiter } from './rate-limit/email-rate-limiter';
import { LoginRateLimiter } from './rate-limit/login-rate-limiter';
import { JwtVerifier } from './request/jwt-verifier.service';
import { RequestAuthGuard } from './request/request-auth.guard';
import { SessionOpener } from './session/session-opener';
import { AccessTokenIssuer } from './token/tokens';

/**
 * S04: gelen token'ın doğrulanması (JwtVerifier, RequestAuthGuard — global,
 * diğer modüller kullanır). S05: şifreyle giriş, refresh token rotasyonu,
 * çıkış, `/auth/user`. S06: kodla şifre sıfırlama, açık kayıt, davet
 * doğrulama (`AuthFlowsController`) ve sunucu içi `AuthAdminService`
 * (S09/S10 kullanır).
 */
@Global()
@Module({
  controllers: [AuthController, AuthFlowsController],
  providers: [
    JwtVerifier,
    RequestAuthGuard,
    AuthService,
    AuthRepository,
    PasswordHasher,
    LoginRateLimiter,
    AccessTokenIssuer,
    SessionOpener,
    AuthFlowsService,
    AuthFlowsRepository,
    AuthAdminService,
    OtpHasher,
    EmailRateLimiter,
  ],
  exports: [
    JwtVerifier,
    AuthService,
    RequestAuthGuard,
    PasswordHasher,
    AccessTokenIssuer,
    AuthAdminService,
  ],
})
export class AuthModule {}
