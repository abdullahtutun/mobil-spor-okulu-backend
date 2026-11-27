/**
 * `POST /rpc/:name` ile dışarıdan çağrılabilen SQL fonksiyonları (K6).
 *
 * Liste uygulamaların gerçekten çağırdıklarıdır: iki uygulamanın
 * `lib/core/data/remote/endpoint.dart` sabitlerinden, yalnızca bir `.rpc(`
 * çağrısında kullanılanlar (2026-11-23: yönetim 61, veli 10, toplam 65), artı
 * S07'nin 23 okuma fonksiyonu (`READS`, aşağıda).
 * `test/rpc-allowlist.e2e-spec.ts` kardeş repolar yanındaysa bu listeyi
 * oradan yeniden çıkarır ve fark varsa düşer.
 *
 * Burada olmayan bir fonksiyon — veritabanında olsa da — 404 `PGRST202`
 * alır (PostgREST'in "fonksiyon yok" cevabı; varlığı da sızmaz). Özellikle
 * girmeyenler: Edge Function'ların service_role ile çağırdıkları
 * (`convert_pre_registration`, `create_public_pre_registration_by_token`,
 * `delete_own_account`, `claim_push_batch`, `complete_push_batch`,
 * `submit_site_lead` …) — onları yalnızca ilgili Nest servisleri
 * `DbContextService.withRole('service_role', …)` ile çağırır; eski
 * istemciler için duran `save_attendances`, `rotate_pre_registration_link`.
 *
 * `callers`: fonksiyonu hangi istek rolüyle çağırmanın kabul edildiği.
 * Fonksiyon isteğin rolüyle çalışır (anon ya da authenticated); bu liste
 * veritabanındaki EXECUTE yetkilerinin önünde ikinci bir kapıdır, onların
 * yerine geçmez. `anon` yalnızca girişten önce sorulanlarda: zorunlu
 * güncelleme kapısı (S02) ve online ön kayıt formunun üç okuması — veritabanı
 * da `anon`'a yalnızca bu dördünü açıyor (20261016'nın denetimi).
 *
 * `apps`: çağıran uygulama (Y = yönetim, V = veli). Yeni bir RPC eklenince
 * buraya bir satır; adı endpoint.dart'takiyle aynı.
 *
 * `reads` (S07): okuma fonksiyonları — uygulamaların bugünkü
 * `.from(tablo).select(...)` okumalarının karşılığı (K7, migration 0007,
 * eşleme docs/migration/read-mapping.md). Değer, yerine geçtiği `.from()`
 * tablosu. S13/S15 uygulamayı `.rpc(` çağrısına çevirene kadar uygulama bu
 * adı çağırmaz; test o sürede tablonun `.from()` okumasının hâlâ durduğuna
 * bakar, sonra adın `.rpc(` ile çağrıldığına.
 */
export type RpcCaller = 'anon' | 'authenticated';
export type RpcApp = 'Y' | 'V';

export interface RpcAllowEntry {
  readonly callers: readonly RpcCaller[];
  readonly apps: readonly RpcApp[];
  readonly reads?: readonly string[];
}

const USER = ['authenticated'] as const;
const PUBLIC = ['anon', 'authenticated'] as const;

/** S07'nin okuma fonksiyonları: `reads` = yerine geçtikleri `.from()` tablosu. */
const READS: Readonly<Record<string, RpcAllowEntry>> = {
  count_unread_notifications: {
    callers: USER,
    apps: ['Y', 'V'],
    reads: ['notifications'],
  },
  get_school: { callers: USER, apps: ['Y'], reads: ['schools'] },
  list_announcements: {
    callers: USER,
    apps: ['Y'],
    reads: ['notification_announcements'],
  },
  list_athletes: { callers: USER, apps: ['Y'], reads: ['athletes'] },
  list_attendances: { callers: USER, apps: ['Y'], reads: ['attendances'] },
  list_birthday_candidates: { callers: USER, apps: ['Y'], reads: ['athletes'] },
  list_branches: { callers: USER, apps: ['Y'], reads: ['branches'] },
  list_classes: { callers: USER, apps: ['Y'], reads: ['classes'] },
  list_coaches: { callers: USER, apps: ['Y'], reads: ['profiles'] },
  list_customers: { callers: USER, apps: ['Y'], reads: ['customers'] },
  list_discounts: { callers: USER, apps: ['Y'], reads: ['discounts'] },
  list_expiring_registrations: {
    callers: USER,
    apps: ['Y'],
    reads: ['athletes'],
  },
  list_financial_records: {
    callers: USER,
    apps: ['Y'],
    reads: ['financial_records'],
  },
  list_income_expense_items: {
    callers: USER,
    apps: ['Y'],
    reads: ['income_expense_items'],
  },
  list_notification_preferences: {
    callers: USER,
    apps: ['Y'],
    reads: ['notification_preferences'],
  },
  list_notifications: {
    callers: USER,
    apps: ['Y', 'V'],
    reads: ['notifications'],
  },
  list_parents: { callers: USER, apps: ['Y'], reads: ['profiles'] },
  list_pre_registrations: {
    callers: USER,
    apps: ['Y'],
    reads: ['pre_registrations'],
  },
  list_role_permissions: {
    callers: USER,
    apps: ['Y'],
    reads: ['role_permissions'],
  },
  list_roles: { callers: USER, apps: ['Y'], reads: ['roles'] },
  list_roster_athletes: { callers: USER, apps: ['Y'], reads: ['athletes'] },
  list_sports: { callers: USER, apps: ['Y'], reads: ['sports'] },
  list_users: { callers: USER, apps: ['Y'], reads: ['profiles'] },
};

export const RPC_ALLOWLIST: Readonly<Record<string, RpcAllowEntry>> = {
  ...READS,
  acknowledge_privacy_notice: { callers: USER, apps: ['Y', 'V'] },
  bulk_delete_athletes: { callers: USER, apps: ['Y'] },
  bulk_delete_pre_registrations: { callers: USER, apps: ['Y'] },
  create_athlete: { callers: USER, apps: ['Y'] },
  create_branch: { callers: USER, apps: ['Y'] },
  create_class: { callers: USER, apps: ['Y'] },
  collect_financial_records: { callers: USER, apps: ['Y'] },
  create_customer: { callers: USER, apps: ['Y'] },
  create_discount: { callers: USER, apps: ['Y'] },
  create_income_expense_item: { callers: USER, apps: ['Y'] },
  create_pre_registration: { callers: USER, apps: ['Y'] },
  create_school: { callers: USER, apps: ['Y'] },
  create_sport: { callers: USER, apps: ['Y'] },
  create_transaction: { callers: USER, apps: ['Y'] },
  delete_athlete: { callers: USER, apps: ['Y'] },
  delete_branch: { callers: USER, apps: ['Y'] },
  delete_class: { callers: USER, apps: ['Y'] },
  delete_class_attendance: { callers: USER, apps: ['Y'] },
  delete_coach: { callers: USER, apps: ['Y'] },
  delete_customer: { callers: USER, apps: ['Y'] },
  delete_discount: { callers: USER, apps: ['Y'] },
  delete_financial_record: { callers: USER, apps: ['Y'] },
  delete_income_expense_item: { callers: USER, apps: ['Y'] },
  delete_parent: { callers: USER, apps: ['Y'] },
  delete_pre_registration: { callers: USER, apps: ['Y'] },
  delete_school: { callers: USER, apps: ['Y'] },
  delete_sport: { callers: USER, apps: ['Y'] },
  delete_user: { callers: USER, apps: ['Y'] },
  get_athlete_profile_summary: { callers: USER, apps: ['Y'] },
  get_attendance_analytics: { callers: USER, apps: ['Y'] },
  get_coach_sole_classes: { callers: USER, apps: ['Y'] },
  get_daily_attendance: { callers: USER, apps: ['Y'] },
  get_dashboard_overview: { callers: USER, apps: ['Y'] },
  get_direct_message_targets: { callers: USER, apps: ['Y'] },
  get_min_app_version: { callers: PUBLIC, apps: ['Y', 'V'] },
  get_pre_registration_link: { callers: USER, apps: ['Y'] },
  get_sent_direct_messages: { callers: USER, apps: ['Y'] },
  get_session_data: { callers: USER, apps: ['Y', 'V'] },
  get_setup_progress: { callers: USER, apps: ['Y'] },
  mark_notifications_read: { callers: USER, apps: ['Y', 'V'] },
  parent_get_athletes: { callers: USER, apps: ['V'] },
  parent_get_attendance: { callers: USER, apps: ['V'] },
  parent_get_payments: { callers: USER, apps: ['V'] },
  parent_set_consents: { callers: USER, apps: ['V'] },
  process_bulk_dues: { callers: USER, apps: ['Y'] },
  process_financial_operation: { callers: USER, apps: ['Y'] },
  public_get_branches_by_token: { callers: PUBLIC, apps: ['Y'] },
  public_get_classes_by_token: { callers: PUBLIC, apps: ['Y'] },
  public_get_school_branding_by_token: { callers: PUBLIC, apps: ['Y'] },
  register_push_token: { callers: USER, apps: ['Y', 'V'] },
  send_announcement: { callers: USER, apps: ['Y'] },
  send_direct_message: { callers: USER, apps: ['Y'] },
  set_athlete_photo: { callers: USER, apps: ['Y'] },
  set_notification_preference: { callers: USER, apps: ['Y'] },
  submit_attendances: { callers: USER, apps: ['Y'] },
  unregister_push_token: { callers: USER, apps: ['Y', 'V'] },
  update_athlete: { callers: USER, apps: ['Y'] },
  update_branch: { callers: USER, apps: ['Y'] },
  update_class: { callers: USER, apps: ['Y'] },
  update_customer: { callers: USER, apps: ['Y'] },
  update_discount: { callers: USER, apps: ['Y'] },
  update_financial_record: { callers: USER, apps: ['Y'] },
  update_income_expense_item: { callers: USER, apps: ['Y'] },
  update_pre_registration: { callers: USER, apps: ['Y'] },
  update_school: { callers: USER, apps: ['Y'] },
  update_sport: { callers: USER, apps: ['Y'] },
};

export function allowEntry(name: string): RpcAllowEntry | undefined {
  return Object.prototype.hasOwnProperty.call(RPC_ALLOWLIST, name)
    ? RPC_ALLOWLIST[name]
    : undefined;
}
