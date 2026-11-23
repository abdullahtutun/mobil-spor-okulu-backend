import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  buildMessage,
  dataParams,
  render,
  type PushLocale,
  type QueuedNotification,
} from './push-content';

/** Yönetim reposunun send-push'u (kardeş repo varsa). */
const EDGE_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'mobil_spor_okulu',
  'supabase',
  'functions',
  'send-push',
  'index.ts',
);

type EdgeRender = (
  type: string,
  params: Record<string, unknown>,
  locale: PushLocale,
) => { title: string; body: string };

/** Edge Function'ın `render()`'ını (ve yardımcılarını) kaynaktan çalıştırılabilir hâle getirir. */
function loadEdgeRender(): EdgeRender {
  const source = readFileSync(EDGE_SOURCE, 'utf8');
  const start = source.indexOf('const num = ');
  const end = source.indexOf('// ─── Google OAuth');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(`${js}
render;`) as EdgeRender;
}

const TYPES = [
  'attendance_reminder',
  'attendance_missing_summary',
  'pre_registration_received',
  'registrations_expiring',
  'payments_due',
  'birthdays_today',
  'birthdays_upcoming',
  'child_birthday_upcoming',
  'attendance_result',
  'payment_upcoming',
  'payment_overdue',
  'announcement',
  'direct_message',
  'bilinmeyen_tur',
];

const PARAM_VARIANTS: Record<string, unknown>[] = [
  {},
  { count: 1, days: 7, class_name: 'Mini A', branch_name: 'Merkez' },
  { count: 3, days: 3, branch_name: '' },
  { count: '12', status: 'absent' },
  { status: 'excused' },
  { status: 'present' },
  { title: 'Tatil', body: 'Yarın antrenman yok.' },
];

describe('push metinleri', () => {
  const edgeAvailable = existsSync(EDGE_SOURCE);
  (edgeAvailable ? it : it.skip)(
    'render() send-push ile bire bir aynı (bütün türler × diller × parametreler)',
    () => {
      const edge = loadEdgeRender();
      let compared = 0;
      for (const type of TYPES) {
        for (const locale of ['tr', 'en'] as const) {
          for (const params of PARAM_VARIANTS) {
            expect(render(type, params, locale)).toEqual(
              edge(type, params, locale),
            );
            compared += 1;
          }
        }
      }
      expect(compared).toBe(TYPES.length * 2 * PARAM_VARIANTS.length);
    },
  );

  it('token dili en değilse Türkçe', () => {
    const n: QueuedNotification = {
      id: 'n1',
      type: 'payment_overdue',
      params: {},
      tokens: [],
    };
    expect(
      buildMessage(n, {
        token: 't',
        locale: 'de',
        platform: 'android',
        app: 'parent',
      }).notification.title,
    ).toBe('Gecikmiş ödeme');
    expect(
      buildMessage(n, {
        token: 't',
        locale: 'en',
        platform: 'ios',
        app: 'parent',
      }).notification.title,
    ).toBe('Overdue payment');
  });
});

describe('push yükünde kişisel veri yok', () => {
  // Satırların gerçekte taşıdığı kişisel alanlar (SQL'deki jsonb_build_object'ler).
  const PERSONAL = {
    athlete_name: 'Zeynep Yılmaz',
    names: ['Can Demir', 'Elif Kaya'],
    full_name: 'Zeynep Yılmaz',
    amount: 1250.5,
    item_name: 'Ekim aidatı',
    phone: '5551234567',
    message: 'Zeynep bugün ateşlendi, eve gönderdik.',
    sender_name: 'Okan Hoca',
    school_name: 'Dev Adım Spor Kulübü',
    age: 9,
    birth_date: '2017-11-30',
    class_name: 'Mini A',
    branch_name: 'Merkez',
  };
  const NEEDLES = [
    'Zeynep',
    'Can Demir',
    'Elif',
    '1250',
    'Ekim aidatı',
    '5551234567',
    'ateşlendi',
    'Okan',
    '2017-11-30',
  ];

  it.each(TYPES.filter((t) => t !== 'announcement'))(
    '%s: başlık, gövde ve data kişisel veri taşımaz',
    (type) => {
      const params = {
        ...PERSONAL,
        count: 2,
        days: 7,
        status: 'absent',
        athlete_id: 'a1',
        class_id: 'c1',
        date: '2026-11-23',
        direct_message_id: 'm1',
        pre_registration_id: 'p1',
        announcement_id: 'x1',
      };
      for (const locale of ['tr', 'en'] as const) {
        const message = buildMessage(
          { id: 'n1', type, params, tokens: [] },
          { token: 'tok', locale, platform: 'android', app: 'management' },
        );
        const text = JSON.stringify(message.notification) + message.data.params;
        for (const needle of NEEDLES) expect(text).not.toContain(needle);
      }
    },
  );

  it('data yalnızca yönlendirme alanlarını taşır', () => {
    const params = {
      ...PERSONAL,
      class_id: 'c1',
      date: '2026-11-23',
      count: 2,
    };
    expect(dataParams('attendance_reminder', params)).toEqual({
      class_id: 'c1',
      date: '2026-11-23',
    });
    expect(dataParams('birthdays_today', params)).toEqual({
      count: 2,
      date: '2026-11-23',
    });
    expect(dataParams('pre_registration_received', params)).toEqual({});
    expect(
      dataParams('attendance_result', { athlete_id: 'a1', status: 'x' }),
    ).toEqual({
      athlete_id: 'a1',
    });
    // send-push'taki gibi eksik kimlik null yazılır.
    expect(dataParams('direct_message', {})).toEqual({
      direct_message_id: null,
      athlete_id: null,
    });
    expect(dataParams('announcement', { title: 'T', body: 'B' })).toEqual({
      announcement_id: null,
    });
    expect(dataParams('bilinmeyen_tur', params)).toEqual({});
  });

  it('mesaj send-push ile aynı şekilde', () => {
    const message = buildMessage(
      {
        id: 'n1',
        type: 'announcement',
        params: { title: 'Tatil', body: 'Yarın yok', announcement_id: 'a9' },
        tokens: [],
      },
      { token: 'tok', locale: 'tr', platform: 'ios', app: 'parent' },
    );
    expect(message).toEqual({
      token: 'tok',
      notification: { title: 'Tatil', body: 'Yarın yok' },
      data: {
        notification_id: 'n1',
        type: 'announcement',
        params: '{"announcement_id":"a9"}',
      },
      android: { priority: 'HIGH' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
  });
});
