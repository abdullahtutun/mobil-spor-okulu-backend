import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { clientInfo } from '../../auth/auth.http';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env.schema';

/**
 * Oturumsuz formların (online ön kayıt, site lead) IP özeti — ex Edge
 * Function'ların `hashIp`'i: `sha256("<tuz>:<ip>")`, hex. IP ham hâliyle hiç
 * saklanmaz; sayım için "aynı mı farklı mı" yeter. Tuz olmadan IPv4 uzayı
 * (2^32) kaba kuvvetle çözülürdü.
 *
 * Tuz `IP_HASH_SALT` (Supabase secrets'takiyle aynı verilirse özetler de
 * aynı). Yoksa Edge'deki gibi gizli bir değerden türetilir (orada service
 * key'in ilk 32 karakteri, burada JWT_SECRET'ın HMAC'ı) ve uyarı loglanır.
 *
 * İstemci IP'si Express'in `trust proxy` kuralıyla (`TRUST_PROXY`): Edge
 * `x-forwarded-for`'un ilk değerine güveniyordu, ki istemcinin kendisi
 * yazabilir; burada yalnızca güvenilen vekilin eklediği değer okunur.
 * Üretimde TRUST_PROXY doğru değilse bütün veliler vekilin tek IP'sinden
 * gelmiş görünür ve saatte 15 sınırı herkese birden uygulanır (S16).
 */
@Injectable()
export class IpHasher {
  private readonly logger = new Logger(IpHasher.name);
  private readonly salt: string;
  private warned = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.salt =
      config.IP_HASH_SALT ||
      createHmac('sha256', config.JWT_SECRET)
        .update('ip-hash-salt')
        .digest('hex')
        .slice(0, 32);
  }

  /** İsteğin IP'si (`::ffff:` öneki atılmış) ya da çözülemezse `null`. */
  clientIp(req: Request): string | null {
    return clientInfo(req).ip;
  }

  hash(ip: string): string {
    if (!this.config.IP_HASH_SALT && !this.warned) {
      this.warned = true;
      this.logger.warn(
        'IP_HASH_SALT tanımlı değil — IP özeti JWT_SECRET’tan türetilen tuzla üretiliyor.',
      );
    }
    return createHash('sha256').update(`${this.salt}:${ip}`).digest('hex');
  }
}
