import { Injectable } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import type { UserJson } from '../auth/user.mapper';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Edge Function'ların `supabaseCaller.auth.getUser()` adımı: token'ın
 * kullanıcısı hâlâ var mı, oturumu açık mı, yasaklı/silinmiş değil mi
 * (`/auth/user` ile aynı kural). Olmazsa `null`; mesajı her fonksiyon kendi
 * seçer. Silinecek/değiştirilecek hesap hiçbir zaman gövdeden alınmaz.
 */
@Injectable()
export class CallerResolver {
  constructor(private readonly auth: AuthService) {}

  async resolve(request: RequestAuth): Promise<UserJson | null> {
    if (request.role !== 'authenticated') return null;
    const sessionId = request.claims.session_id;
    try {
      return await this.auth.getUser({
        userId: request.claims.sub as string,
        sessionId:
          typeof sessionId === 'string' && UUID.test(sessionId)
            ? sessionId
            : null,
      });
    } catch {
      return null;
    }
  }
}
