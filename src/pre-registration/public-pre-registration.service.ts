import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Envelope } from '../accounts/accounts.repository';
import {
  appFailure,
  appOk,
  type AppOk,
  FunctionFailure,
} from '../accounts/function-response';
import { DbContextService } from '../db/db-context.service';
import { RpcService } from '../rpc/rpc.service';
import { PreRegistrationRepository } from './pre-registration.repository';

/**
 * `create_public_pre_registration_by_token`'ın bütün parametreleri, null'la.
 * Edge Function'daki liste: PostgREST aşırı yüklenmiş fonksiyonu gönderilen
 * anahtar kümesine göre seçer; eksik bir opsiyonel "function not found"
 * olurdu. Rıza alanları (`p_photo_consent`, `p_promo_photo_consent`)
 * Edge'deki gibi listede yok: varsayılanları var, form gönderir.
 */
const RPC_DEFAULTS: Readonly<Record<string, null>> = {
  p_token: null,
  p_full_name: null,
  p_gender: null,
  p_date_of_birth: null,
  p_branch_id: null,
  p_class_id: null,
  p_national_id: null,
  p_phone: null,
  p_height: null,
  p_weight: null,
  p_health_problems: null,
  p_has_health_report: null,
  p_has_sports_history: null,
  p_address: null,
  p_parent_full_name: null,
  p_parent_phone: null,
  p_parent_email: null,
  p_parent2_full_name: null,
  p_parent2_phone: null,
  p_parent2_email: null,
  p_interview_date: null,
  p_referral_source: null,
  p_kvkk_approved: null,
  p_health_consent: null,
};

const INTERNAL = 'Beklenmeyen bir hata oluştu.';

/**
 * Ex `submit-pre-registration` (yönetim reposu
 * `supabase/functions/submit-pre-registration/index.ts`): online ön kayıt
 * formunun tek yazma yolu.
 *
 * Sıra bire bir: token var mı → IP sınırı (saatte 15, sayma + kaydetme tek
 * çağrıda) → `create_public_pre_registration_by_token` (service_role; token
 * çözümü, şube/sınıf okul denetimi, telefon başına sınır, 24 saat kopya,
 * insert orada). RPC `anon`'a kapalı; bu katman atlanamaz.
 *
 * Yanıtlar Edge'inkiyle aynı: başarı 200 `appOk`, IP sınırı 429 `conflict`,
 * RPC'nin reddi 409 (`conflict`) ya da 400, RPC/SQL hatası 500
 * "Kayıt sırasında…", diğer her şey 500 "Beklenmeyen…".
 */
@Injectable()
export class PublicPreRegistrationService {
  private readonly logger = new Logger(PublicPreRegistrationService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: PreRegistrationRepository,
    private readonly rpc: RpcService,
  ) {}

  /**
   * `rawBody` istek gövdesinin metni (`rawTextBody`); `ipHash` çözülemeyen
   * IP'de `null` (sınır uygulanmaz — bazı vekil düzenleri başlık göndermez).
   */
  async submit(rawBody: unknown, ipHash: string | null): Promise<AppOk> {
    try {
      const body = parseBody(rawBody);
      // Eski istemciler `turnstile_token` gönderebilir; RPC'ye gitmemeli
      // (captcha Ekim 2026'da kaldırıldı).
      const payload = { ...body };
      delete payload.turnstile_token;

      if (!payload.p_token) {
        throw appFailure('Bağlantı bilgisi eksik.', 'validation');
      }

      // 1. IP sınırı. Sayaç çalışmazsa istek reddedilmez: koruma katmanının
      // arızası gerçek velileri kesmemeli; telefon sınırları RPC'de.
      if (ipHash) {
        let throttle: Envelope | null = null;
        try {
          throttle = await this.db.withRole('service_role', (c) =>
            this.repo.recordAttempt(c, ipHash),
          );
        } catch (error) {
          this.logger.error(
            { err: (error as Error).message },
            'IP sayacı okunamadı',
          );
        }
        const data = throttle?.data as {
          allowed?: boolean;
          recent?: number;
        } | null;
        if (throttle?.success && data?.allowed === false) {
          this.logger.warn({ recent: data.recent }, 'IP sınırı aşıldı');
          throw appFailure(
            'Kısa sürede çok fazla ön kayıt gönderildi. Lütfen bir süre sonra tekrar deneyin.',
            'conflict',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }

      // 2. Kayıt. Zarf olduğu gibi geçer; eksik parametreler null.
      let result: Envelope | null;
      try {
        result = (await this.rpc.callAs(
          { role: 'service_role' },
          'create_public_pre_registration_by_token',
          { ...RPC_DEFAULTS, ...payload },
        )) as Envelope | null;
      } catch (error) {
        this.logger.error({ err: (error as Error).message }, 'RPC hatası');
        throw appFailure(
          'Kayıt sırasında bir hata oluştu.',
          'internal',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      if (!result?.success) {
        const code = result?.code ?? 'internal';
        throw appFailure(
          result?.message ?? 'Kayıt oluşturulamadı.',
          code,
          code === 'conflict' ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST,
        );
      }
      return appOk(
        result.message ?? 'Ön kayıt başarıyla alındı.',
        result.data ?? null,
      );
    } catch (error) {
      if (error instanceof FunctionFailure) throw error;
      this.logger.error({ err: error }, 'Beklenmeyen hata');
      throw appFailure(INTERNAL, 'internal', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

/**
 * Edge'in `await req.json()` + destructuring'i: bozuk JSON ve `null` 500;
 * nesne olmayan değerin (dizi, sayı, metin) anahtarları kayda gitmez ve
 * token bulunamaz (400).
 */
function parseBody(raw: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : '');
  if (parsed === null || parsed === undefined) throw new Error('gövde null');
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}
