import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { clientInfo, parseAuthBody, withRetryAfter } from '../auth.http';
import type { SessionResponse } from '../session/session-opener';
import type { UserJson } from '../user.mapper';
import { AuthFlowsService } from './auth-flows.service';

// Bilinmeyen alanlar yok sayılır (supabase-dart `gotrue_meta_security`,
// `code_challenge` gibi alanlar gönderebilir); tanınanlar doğrulanır.
const email = z.string().trim().min(1).max(255);
const recoverBody = z.object({ email });
const signupBody = z.object({
  email,
  password: z.string().min(1).max(1024),
  data: z.record(z.string(), z.unknown()).optional(),
});
const resendBody = z.object({ type: z.literal('signup'), email });
const verifyBody = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['recovery', 'signup']),
    email,
    token: z.string().min(1).max(32),
  }),
  z.object({
    type: z.literal('invite'),
    token_hash: z.string().min(1).max(256),
  }),
]);

/**
 * Kodlu auth akışları (S06; sözleşme `docs/api/auth.md`). Hiçbiri token
 * istemez; hepsi hız sınırlı.
 */
@Controller('auth')
export class AuthFlowsController {
  constructor(private readonly flows: AuthFlowsService) {}

  /** Şifre sıfırlama kodu. Hesap olsun olmasın 200 `{}`. */
  @Post('recover')
  @HttpCode(200)
  recover(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, never>> {
    const { email } = parseAuthBody(recoverBody, body ?? {});
    return withRetryAfter(res, async () => {
      await this.flows.recover(email, clientInfo(req));
      return {};
    });
  }

  /** Açık kayıt (sihirbaz): onaysız hesap + kod e-postası; yanıt `user`. */
  @Post('signup')
  @HttpCode(200)
  signup(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserJson> {
    const input = parseAuthBody(signupBody, body ?? {});
    return withRetryAfter(res, () =>
      this.flows.signup(
        input.email,
        input.password,
        input.data ?? {},
        clientInfo(req),
      ),
    );
  }

  /** Kayıt kodunu yeniden gönderir. Her zaman 200 `{}`. */
  @Post('resend')
  @HttpCode(200)
  resend(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, never>> {
    const { email } = parseAuthBody(resendBody, body ?? {});
    return withRetryAfter(res, async () => {
      await this.flows.resendSignup(email, clientInfo(req));
      return {};
    });
  }

  /** Kod ya da davet bağlantısı → oturum (`POST /auth/token` yanıtı). */
  @Post('verify')
  @HttpCode(200)
  verify(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const input = parseAuthBody(verifyBody, body ?? {});
    return withRetryAfter(res, () => this.flows.verify(input, clientInfo(req)));
  }
}
