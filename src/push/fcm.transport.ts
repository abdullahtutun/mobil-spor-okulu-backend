import { createSign } from 'node:crypto';
import type { FcmMessage } from './push-content';

/** Bir mesajın FCM'den dönüşü: başarı ya da HTTP durumu + ham gövde. */
export type FcmSendResult =
  { ok: true } | { ok: false; status: number; body: string };

/**
 * FCM'e giden tek kapı. Gerçeği `HttpFcmTransport` (HTTP v1); testler sahte
 * bir taşıyıcı takar (`test/support/fake-fcm.ts`) — gerçek FCM'e hiçbir
 * test gitmez.
 */
export interface FcmTransport {
  /** Servis hesabı tanımlı ve okunabilir mi; değilse push kapalı. */
  readonly configured: boolean;
  /** Gönderimden önce (kuyruk okunmadan) erişim token'ını hazırlar. */
  prepare(): Promise<void>;
  send(message: FcmMessage): Promise<FcmSendResult>;
}

export const FCM_TRANSPORT = Symbol('FCM_TRANSPORT');

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** `FCM_SERVICE_ACCOUNT` → servis hesabı; boş ya da bozuksa `null` + neden. */
export function parseServiceAccount(raw: string): {
  account: ServiceAccount | null;
  error: string | null;
} {
  if (raw.trim() === '') return { account: null, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      account: null,
      error: 'FCM_SERVICE_ACCOUNT geçerli bir JSON değil.',
    };
  }
  const a = parsed as Partial<ServiceAccount> | null;
  if (
    !a ||
    typeof a.project_id !== 'string' ||
    typeof a.client_email !== 'string' ||
    typeof a.private_key !== 'string'
  ) {
    return {
      account: null,
      error:
        'FCM_SERVICE_ACCOUNT project_id, client_email ve private_key içermeli.',
    };
  }
  return { account: a as ServiceAccount, error: null };
}

const base64Url = (input: Buffer | string) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

type FetchFn = typeof fetch;

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * FCM HTTP v1 — send-push'un `accessToken()` ve `sendToToken()`'ının portu:
 * servis hesabıyla imzalı (RS256) JWT → Google OAuth erişim token'ı (bir
 * saat; bir dakika kala yenilenir) → `messages:send`. `firebase-admin`
 * kullanılmadı: ölü token kararı (`isDeadToken`) FCM'in ham hata gövdesine
 * bakıyor, firebase-admin ise gövdeyi kendi hata koduna çeviriyor
 * (`fieldViolations` kayboluyor) ve karar send-push'unkinden farklılaşırdı.
 */
export class HttpFcmTransport implements FcmTransport {
  private cached: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: ServiceAccount | null,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get configured(): boolean {
    return this.account !== null;
  }

  async prepare(): Promise<void> {
    await this.accessToken();
  }

  async send(message: FcmMessage): Promise<FcmSendResult> {
    const account = this.requireAccount();
    const bearer = await this.accessToken();
    const response = await this.fetchFn(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, body: await response.text() };
  }

  private requireAccount(): ServiceAccount {
    if (!this.account) throw new Error('FCM servis hesabı tanımlı değil.');
    return this.account;
  }

  private async accessToken(): Promise<string> {
    const account = this.requireAccount();
    const now = Math.floor(this.now() / 1000);
    if (this.cached && this.cached.expiresAt - 60 > now) {
      return this.cached.value;
    }
    const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    );
    const unsigned = `${header}.${claims}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(account.private_key);

    const response = await this.fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${base64Url(signature)}`,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Gövde loglanmaz/sızdırılmaz; durum kodu yeter.
      throw new Error(
        `Google erişim token'ı alınamadı: HTTP ${response.status}`,
      );
    }
    const result = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.cached = {
      value: result.access_token,
      expiresAt: now + Number(result.expires_in ?? 3600),
    };
    return result.access_token;
  }
}
