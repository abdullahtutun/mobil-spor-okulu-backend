import type { FcmSendResult, FcmTransport } from '../../src/push/fcm.transport';
import type { FcmMessage } from '../../src/push/push-content';

/**
 * Testlerin FCM'i: gerçek Google'a gitmez, gönderilenleri tutar
 * (`createTestApp` her uygulamaya takar, `fcmOf(app)`). Varsayılan olarak
 * yapılandırılmamış (FCM_SERVICE_ACCOUNT boş gibi); test `configured = true`
 * yapar. `respond` token başına yanıt seçer (varsayılan başarı).
 */
export class FakeFcm implements FcmTransport {
  configured = false;
  readonly sent: FcmMessage[] = [];
  prepareError: Error | null = null;
  respond: (message: FcmMessage) => FcmSendResult | Error = () => ({
    ok: true,
  });

  prepare(): Promise<void> {
    return this.prepareError
      ? Promise.reject(this.prepareError)
      : Promise.resolve();
  }

  send(message: FcmMessage): Promise<FcmSendResult> {
    const result = this.respond(message);
    if (result instanceof Error) return Promise.reject(result);
    if (result.ok) this.sent.push(message);
    return Promise.resolve(result);
  }

  reset(): void {
    this.configured = false;
    this.sent.length = 0;
    this.prepareError = null;
    this.respond = () => ({ ok: true });
  }
}

/** FCM HTTP v1'in hata gövdesi (send-push/fcm_error_test.ts biçimi). */
export function fcmErrorBody(
  status: string,
  message: string,
  errorCode?: string,
): string {
  return JSON.stringify({
    error: {
      code: 400,
      message,
      status,
      details: errorCode
        ? [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode,
            },
          ]
        : [],
    },
  });
}
