/**
 * Push metinleri ve `data` yükü — yönetim reposundaki
 * `supabase/functions/send-push/index.ts`'in `render()` ve `dataParams()`
 * fonksiyonlarının portu. `render()` bire bir aynıdır (push-content.spec.ts
 * kaynak dosya varsa iki çıktıyı karşılaştırır); yeni bir bildirim türü
 * eklenince İKİSİ de güncellenir (yönetim AGENTS.md → "Adding a
 * notification type").
 *
 * GİZLİLİK (send-push ile aynı kural): kilit ekranına kişisel veri yazılmaz
 * — çocuk adı, tutar, telefon yok. Duyuru istisnadır (gönderen herkesin
 * göreceğini bilerek yazıyor); veliye özel mesaj istisna değildir.
 *
 * `dataParams()`'ta BİLİNÇLİ FARK: send-push personel türlerinde satırın
 * bütün `params`'ını `data`'ya koyuyordu; `birthdays_today` /
 * `birthdays_upcoming` orada sporcu adlarını (`names`, ilk beş), ve
 * `pre_registration_received` çocuğun adını (`athlete_name`) taşıyor. `data`
 * kilit ekranında görünmese de FCM'den geçer, cihazın bildirim geçmişinde ve
 * loglarda kalır — yönetimin "pushes carry no personal data" kuralına
 * aykırı. Burada her tür yalnızca uygulamanın yönlendirme için okuduğu
 * alanları taşır (`NotificationDestination`: `class_id`, `date`); geri
 * kalanlar uygulamada satırdan okunur.
 */

export type PushLocale = 'tr' | 'en';

export interface PushText {
  title: string;
  body: string;
}

const num = (value: unknown) => Number(value ?? 0);
const str = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // send-push `String(value)` yazıyordu; nesne/dizi için JSON'un `String`'i
  // aynı sonucu vermez ama bu alanlar SQL'de her zaman düz metin.
  return JSON.stringify(value);
};

export function render(
  type: string,
  params: Record<string, unknown>,
  locale: PushLocale,
): PushText {
  const en = locale === 'en';
  const count = num(params.count);

  switch (type) {
    case 'attendance_reminder':
      return en
        ? {
            title: 'Attendance reminder',
            body: `Attendance for ${str(params.class_name)} hasn't been taken today.`,
          }
        : {
            title: 'Yoklama hatırlatması',
            body: `${str(params.class_name)} sınıfının bugünkü yoklaması henüz alınmadı.`,
          };

    case 'attendance_missing_summary':
      return en
        ? {
            title: 'Missing attendance',
            body:
              count === 1
                ? "1 class's attendance wasn't taken yesterday."
                : `${count} classes' attendance wasn't taken yesterday.`,
          }
        : {
            title: 'Eksik yoklama',
            body: `Dün ${count} sınıfın yoklaması alınmadı.`,
          };

    case 'pre_registration_received': {
      const branch = str(params.branch_name);
      return en
        ? {
            title: 'New online pre-registration',
            body: branch
              ? `A new pre-registration arrived for ${branch}.`
              : 'A new pre-registration arrived.',
          }
        : {
            title: 'Yeni online ön kayıt',
            body: branch
              ? `${branch} şubesine yeni bir ön kayıt geldi.`
              : 'Yeni bir ön kayıt geldi.',
          };
    }

    case 'registrations_expiring': {
      const days = num(params.days);
      return en
        ? {
            title: 'Registrations expiring',
            body:
              count === 1
                ? `1 athlete's registration ends in ${days} days.`
                : `${count} athletes' registrations end in ${days} days.`,
          }
        : {
            title: 'Kaydı bitenler',
            body: `${count} sporcunun kaydı ${days} gün sonra bitiyor.`,
          };
    }

    case 'payments_due':
      return en
        ? {
            title: 'Payments to follow up',
            body:
              count === 1
                ? '1 payment is due for follow-up today.'
                : `${count} payments are due for follow-up today.`,
          }
        : {
            title: 'Takipteki ödemeler',
            body: `Bugün takip edilmesi gereken ${count} ödeme var.`,
          };

    case 'birthdays_today':
      return en
        ? {
            title: 'Birthdays today 🎂',
            body:
              count === 1
                ? 'One of your athletes has a birthday today.'
                : `${count} of your athletes have a birthday today.`,
          }
        : {
            title: 'Bugün doğum günü 🎂',
            body: `Bugün ${count} sporcunuzun doğum günü.`,
          };

    case 'birthdays_upcoming': {
      const days = num(params.days);
      return en
        ? {
            title: 'Upcoming birthdays 🎂',
            body:
              count === 1
                ? `One athlete has a birthday in ${days} days.`
                : `${count} athletes have a birthday in ${days} days.`,
          }
        : {
            title: 'Yaklaşan doğum günü 🎂',
            body: `${days} gün sonra ${count} sporcunun doğum günü.`,
          };
    }

    case 'child_birthday_upcoming':
      // Veliye: çocuğun adı kilit ekranına yazılmaz.
      return en
        ? {
            title: 'A birthday is coming up 🎂',
            body: "Your child's birthday is one week away.",
          }
        : {
            title: 'Doğum günü yaklaşıyor 🎂',
            body: 'Çocuğunuzun doğum gününe bir hafta kaldı.',
          };

    case 'attendance_result':
      // Veliye: çocuğun adı ve sınıfı yok, yalnızca sonuç.
      switch (str(params.status)) {
        case 'absent':
          return en
            ? {
                title: 'Attendance',
                body: 'Your child did not attend training.',
              }
            : {
                title: 'Yoklama sonucu',
                body: 'Çocuğunuz antrenmana katılmadı.',
              };
        case 'excused':
          return en
            ? {
                title: 'Attendance',
                body: 'Your child was marked excused from training.',
              }
            : {
                title: 'Yoklama sonucu',
                body: 'Çocuğunuz antrenmanda izinli sayıldı.',
              };
        default:
          return en
            ? { title: 'Attendance', body: 'Your child attended training.' }
            : {
                title: 'Yoklama sonucu',
                body: 'Çocuğunuz antrenmana katıldı.',
              };
      }

    case 'payment_upcoming': {
      // Tutar ve kalem adı kilit ekranına yazılmaz.
      const days = num(params.days);
      return en
        ? {
            title: 'Payment reminder',
            body: `You have a payment due in ${days} days.`,
          }
        : {
            title: 'Ödeme hatırlatması',
            body: `Vadesi ${days} gün sonra dolan bir ödemeniz var.`,
          };
    }

    case 'payment_overdue':
      return en
        ? {
            title: 'Overdue payment',
            body: 'You have a payment past its due date.',
          }
        : { title: 'Gecikmiş ödeme', body: 'Vadesi geçmiş bir ödemeniz var.' };

    case 'announcement':
      // Gönderenin metni: çevrilmez.
      return { title: str(params.title), body: str(params.body) };

    case 'direct_message':
      // Metin ve çocuğun adı kilit ekranına yazılmaz.
      return en
        ? {
            title: 'New message from the school',
            body: 'Open the app to read it.',
          }
        : { title: 'Okuldan yeni mesaj', body: 'Okumak için uygulamayı açın.' };

    default:
      return en
        ? { title: 'New notification', body: 'Open the app to see it.' }
        : { title: 'Yeni bildirim', body: 'Görmek için uygulamayı açın.' };
  }
}

/**
 * Tür başına `data.params`'a girebilecek alanlar (yukarıdaki gizlilik
 * notu). Listede olmayan tür boş nesne taşır.
 */
const DATA_KEYS: Record<string, readonly string[]> = {
  // Yönetim: NotificationDestination class_id + date okur.
  attendance_reminder: ['class_id', 'date'],
  attendance_missing_summary: ['count', 'date'],
  registrations_expiring: ['count', 'days', 'date'],
  payments_due: ['count', 'date'],
  birthdays_today: ['count', 'date'],
  birthdays_upcoming: ['count', 'days', 'date'],
  pre_registration_received: ['pre_registration_id', 'branch_id'],
  // Veli: dokununca hangi çocuğun seçileceği yeter (send-push ile aynı).
  child_birthday_upcoming: ['athlete_id'],
  attendance_result: ['athlete_id'],
  payment_upcoming: ['athlete_id'],
  payment_overdue: ['athlete_id'],
  direct_message: ['direct_message_id', 'athlete_id'],
  // Başlık ve gövde zaten `notification`'da; 4 KB sınırı (send-push).
  announcement: ['announcement_id'],
};

/** Değeri olmayan alan send-push'taki gibi `null` yazılan türler. */
const NULL_WHEN_MISSING = new Set([
  'announcement',
  'child_birthday_upcoming',
  'attendance_result',
  'payment_upcoming',
  'payment_overdue',
  'direct_message',
]);

export function dataParams(
  type: string,
  params: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const keys = DATA_KEYS[type] ?? [];
  const source = params ?? {};
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) out[key] = source[key];
    else if (NULL_WHEN_MISSING.has(type)) out[key] = null;
  }
  return out;
}

/** Kuyruktan gelen bir bildirim (`claim_push_batch`'in `data` elemanı). */
export interface QueuedNotification {
  id: string;
  type: string;
  params: Record<string, unknown> | null;
  tokens: PushTokenRow[];
}

export interface PushTokenRow {
  token: string;
  locale: string;
  platform: string;
  app: string;
}

/** FCM HTTP v1 `message` nesnesi — send-push'unkiyle aynı alanlar. */
export interface FcmMessage {
  token: string;
  notification: PushText;
  data: { notification_id: string; type: string; params: string };
  android: { priority: 'HIGH' };
  apns: { payload: { aps: { sound: 'default' } } };
}

export function buildMessage(
  notification: QueuedNotification,
  token: PushTokenRow,
): FcmMessage {
  const locale: PushLocale = token.locale === 'en' ? 'en' : 'tr';
  return {
    token: token.token,
    notification: render(notification.type, notification.params ?? {}, locale),
    // FCM `data` değerleri yalnızca string kabul eder.
    data: {
      notification_id: notification.id,
      type: notification.type,
      params: JSON.stringify(
        dataParams(notification.type, notification.params),
      ),
    },
    android: { priority: 'HIGH' },
    // Uygulama ikonu rozeti (`badge`) bilerek yok (send-push).
    apns: { payload: { aps: { sound: 'default' } } },
  };
}
