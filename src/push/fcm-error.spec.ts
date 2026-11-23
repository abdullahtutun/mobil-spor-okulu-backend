import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { isDeadToken } from './fcm-error';

const EDGE_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'mobil_spor_okulu',
  'supabase',
  'functions',
  'send-push',
  'fcm_error.ts',
);

// send-push/fcm_error_test.ts'teki gövde biçimi (FCM HTTP v1).
const fcmError = (
  status: string,
  message: string,
  errorCode?: string,
  fields: string[] = [],
) =>
  JSON.stringify({
    error: {
      code: 400,
      message,
      status,
      details: [
        ...(errorCode
          ? [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode,
              },
            ]
          : []),
        ...(fields.length
          ? [
              {
                '@type': 'type.googleapis.com/google.rpc.BadRequest',
                fieldViolations: fields.map((field) => ({
                  field,
                  description: 'x',
                })),
              },
            ]
          : []),
      ],
    },
  });

const CASES: [string, string, boolean][] = [
  [
    'kaldırılmış uygulama',
    fcmError('NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED'),
    true,
  ],
  [
    'biçimi bozuk token (alan yok)',
    fcmError(
      'INVALID_ARGUMENT',
      'The registration token is not a valid FCM registration token',
      'INVALID_ARGUMENT',
    ),
    true,
  ],
  [
    'biçimi bozuk token (alan token)',
    fcmError('INVALID_ARGUMENT', 'Invalid token', 'INVALID_ARGUMENT', [
      'message.token',
    ]),
    true,
  ],
  [
    'geçersiz data değeri',
    fcmError(
      'INVALID_ARGUMENT',
      "Invalid value at 'message.data[0].value'",
      'INVALID_ARGUMENT',
      ['message.data[0].value'],
    ),
    false,
  ],
  [
    'yük çok büyük',
    fcmError(
      'INVALID_ARGUMENT',
      'Request contains an invalid argument.',
      'INVALID_ARGUMENT',
    ),
    false,
  ],
  [
    'token + başka alan',
    fcmError(
      'INVALID_ARGUMENT',
      'The registration token is not a valid FCM registration token',
      'INVALID_ARGUMENT',
      ['message.token', 'message.android.priority'],
    ),
    false,
  ],
  [
    'APNs kimlik hatası',
    fcmError(
      'UNAUTHENTICATED',
      'Auth error from APNS or Web Push Service for registration token',
      'THIRD_PARTY_AUTH_ERROR',
    ),
    false,
  ],
  [
    'servis yok',
    fcmError(
      'UNAVAILABLE',
      'The service is currently unavailable.',
      'UNAVAILABLE',
    ),
    false,
  ],
  [
    'kota',
    fcmError('RESOURCE_EXHAUSTED', 'Quota exceeded.', 'QUOTA_EXCEEDED'),
    false,
  ],
  ['JSON değil', '<html>502 Bad Gateway</html>', false],
  ['boş', '', false],
  ['null', 'null', false],
];

describe('isDeadToken (send-push/fcm_error.ts kopyası)', () => {
  it.each(CASES)('%s', (_, body, dead) => {
    expect(isDeadToken(body)).toBe(dead);
  });

  (existsSync(EDGE_SOURCE) ? it : it.skip)('kaynakla aynı kararı verir', () => {
    const js = ts.transpileModule(readFileSync(EDGE_SOURCE, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
    const exports: { isDeadToken?: (b: string) => boolean } = {};
    runInNewContext(js, { exports });
    for (const [, body] of CASES) {
      expect(isDeadToken(body)).toBe(exports.isDeadToken!(body));
    }
  });
});
