import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { RPC_ALLOWLIST } from '../src/rpc/rpc-allowlist';
import {
  ATHLETES,
  BRANCH_A1,
  BRANCH_A2,
  SCHOOL_A,
  SCHOOL_B,
  USERS,
} from './fixtures/seed-ids';
import { createTestApp } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';
import { startPostgrest, type TestPostgrest } from './support/postgrest';
import { supabaseAnonKey, supabaseUserToken } from './support/tokens';

/**
 * S07 — okuma fonksiyonları (0007) uygulamaların bugün PostgREST'ten aldığı
 * JSON'u aynen veriyor mu?
 *
 * Her durum iki kez sorulur: uygulamanın `.from()` sorgusu, aynı veritabanına
 * bağlı gerçek bir PostgREST'e (supabase-dart'ın ürettiği adresle), ve
 * karşılığı olan fonksiyon bizim `POST /rpc/:name`'imize. İki JSON, her
 * kullanıcı için ayrı ayrı (genel müdür, şube müdürü, antrenör, muhasebeci,
 * veli, pasif veli, silinmiş hesap, B okulu) eşit olmalı — böylece RLS'in
 * (okul, şube, `is_deleted`, `parent_no_direct_access`, pasif/silinmiş hesap)
 * bire bir korunduğu da sınanır, tek tek kural yazmadan.
 *
 * Sıra: uygulamanın `order`'ı olan okumalarda dizi sırası da karşılaştırılır;
 * sırasızlarda (PostgREST'te tanımsız) küme olarak. Gömülü dizilerin sırası
 * PostgREST'te tanımsızdır, onlar her zaman küme olarak.
 */

const A = USERS.a;
const B = USERS.b;

/** Testte eklenen kimlikler (seed'e ek, yalnızca bu veritabanında). */
const X = {
  deletedAthlete: 'a0000000-0000-4000-8000-000000000199',
  discountA1: 'a0000000-0000-4000-8000-0000000000f1',
  discountAll: 'a0000000-0000-4000-8000-0000000000f2',
  discountB: 'b0000000-0000-4000-8000-0000000000f1',
  externalCustomer: 'a0000000-0000-4000-8000-0000000000e9',
  expenseRecord: 'a0000000-0000-4000-8000-0000000000ea',
  announcement: 'a0000000-0000-4000-8000-0000000000aa',
  notifParent: 'a0000000-0000-4000-8000-000000000a03',
  notifManagerRead: 'a0000000-0000-4000-8000-000000000a01',
  notifManagerUnread: 'a0000000-0000-4000-8000-000000000a02',
  notifB: 'b0000000-0000-4000-8000-000000000a01',
} as const;

const FIXTURES = `
-- Silinmiş hesap: diyetisyen (zaten uygulamaya giremez) silinmiş sayılır.
update public.profiles set is_deleted = true where id = '${A.dietician}';

-- Silinmiş sporcu (A1) — hiçbir listede görünmemeli.
insert into public.athletes (id, branch_id, gender, date_of_birth, registration_date,
  contract_end_date, approval_status, school_id, class_id, full_name, is_deleted)
values ('${X.deletedAthlete}', '${BRANCH_A1}', 'female', '2015-01-01', '2026-09-01',
  '2027-06-30', 'active', '${SCHOOL_A}', 'a0000000-0000-4000-8000-0000000000d1',
  'Silinen Deneme', true);

-- Silinmiş bir şube bağı (müdür yardımcısı → A2).
insert into public.profile_branch_links (profile_id, branch_id, school_id, is_deleted)
values ('${A.assistant}', '${BRANCH_A2}', '${SCHOOL_A}', true);

-- İndirimler: A1'e bağlı, bağsız (okul geneli), B okulunun.
insert into public.discounts (id, school_id, name, type, value, created_at) values
  ('${X.discountA1}', '${SCHOOL_A}', 'Kardeş', 'percentage', 10, '2026-09-01 10:00+00'),
  ('${X.discountAll}', '${SCHOOL_A}', 'Erken Kayıt', 'fixed_amount', 250.50, '2026-09-02 10:00+00'),
  ('${X.discountB}', '${SCHOOL_B}', 'Kardeş', 'percentage', 15, '2026-09-03 10:00+00');
insert into public.branch_discount_links (branch_id, discount_id, school_id) values
  ('${BRANCH_A1}', '${X.discountA1}', '${SCHOOL_A}');
insert into public.branch_income_expense_item_links (branch_id, income_expense_item_id, school_id) values
  ('${BRANCH_A1}', 'a0000000-0000-4000-8000-0000000000e1', '${SCHOOL_A}');

-- Harici cari ve A2'ye bir gider; silinmiş bir tahsilat (veri olarak okunur).
insert into public.customers (id, display_name, type, phone, school_id) values
  ('${X.externalCustomer}', 'Deneme Malzeme Ltd.', 'external', '2320000099', '${SCHOOL_A}');
insert into public.financial_records (id, customer_id, branch_id, type, name, expected_date,
  base_amount, discount_amount, net_amount, status, created_by, school_id, is_deleted)
values ('${X.expenseRecord}', '${X.externalCustomer}', '${BRANCH_A2}', 'expense', 'Top alımı',
  '2026-09-05', 990.10, 0, 990.10, 'unpaid', '${A.generalManager}', '${SCHOOL_A}', false);
insert into public.transactions (record_id, amount, method, transaction_date, processed_by,
  school_id, branch_id, is_deleted)
select id, 1, 'cash', timestamptz '2026-09-08 12:00+03', '${A.accountant}', school_id, branch_id, true
  from public.financial_records where id = 'f0000000-0000-4000-8000-000000000102';

-- Ön kayıtlar (A1, A2, B). Oturumsuz eklendiği için trigger yöneticilere
-- bildirim de yazar.
insert into public.pre_registrations (school_id, full_name, gender, date_of_birth, phone,
  class_id, branch_id, interviewer_name, interview_date, parent_full_name, parent_phone,
  parent_email, created_at)
values
  ('${SCHOOL_A}', 'Aday Bir', 'male', '2017-01-01', null, 'a0000000-0000-4000-8000-0000000000d1',
   '${BRANCH_A1}', 'Kemal', '2026-09-20', 'Veli Bir', '5550000201', 'veli.bir@a.test', '2026-09-15 10:00+00'),
  ('${SCHOOL_A}', 'Aday İki', 'female', '2015-05-05', null, 'a0000000-0000-4000-8000-0000000000d2',
   '${BRANCH_A2}', 'Pelin', '2026-09-21', 'Veli İki', '5550000202', 'veli.iki@a.test', '2026-09-16 10:00+00'),
  ('${SCHOOL_B}', 'Aday Üç', 'male', '2019-03-03', null, 'b0000000-0000-4000-8000-0000000000d1',
   'b0000000-0000-4000-8000-0000000000b1', 'Derya', '2026-09-22', 'Veli Üç', '5550000203', 'veli.uc@b.test', '2026-09-17 10:00+00');

-- Duyuru ve bildirimler (zamanlar ayrı: sıra karşılaştırılabilsin).
insert into public.notification_announcements (id, school_id, sender_id, title, body,
  role_ids, branch_ids, recipient_count, created_at)
values ('${X.announcement}', '${SCHOOL_A}', '${A.generalManager}', 'Tatil', 'Pazartesi antrenman yok.',
  '{4,8}', '{${BRANCH_A1}}', 3, '2026-09-18 09:00+00');
insert into public.notifications (id, school_id, recipient_id, type, params, read_at, created_at)
values
  ('${X.notifParent}', '${SCHOOL_A}', '${A.parent}', 'announcement',
   '{"title":"Tatil","body":"Pazartesi antrenman yok.","sender_name":"Deneme Spor Kulübü"}', null, '2026-09-18 09:00+00'),
  ('${X.notifManagerRead}', '${SCHOOL_A}', '${A.generalManager}', 'payments_due',
   '{"count":3}', '2026-09-18 10:00+00', '2026-09-18 08:00+00'),
  ('${X.notifManagerUnread}', '${SCHOOL_A}', '${A.generalManager}', 'registrations_expiring',
   '{"count":1}', null, '2026-09-19 08:00+00'),
  ('${X.notifB}', '${SCHOOL_B}', '${B.parent}', 'announcement', '{"title":"B"}', null, '2026-09-18 09:30+00');
insert into public.notification_preferences (profile_id, type, push_enabled) values
  ('${A.generalManager}', 'payments_due', false),
  ('${A.generalManager}', 'birthdays_today', true),
  ('${A.coach}', 'attendance_reminder', false),
  ('${B.generalManager}', 'payments_due', false);
`;

type Json = unknown;

/** Nesne anahtarlarını ve (derinlikteki) dizileri sıraya koyar. */
function canonical(value: Json, sortThisArray: boolean): Json {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v, true));
    return sortThisArray
      ? [...items].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        )
      : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v, true)]),
    );
  }
  return value;
}

interface ReadCase {
  /** Okumanın adı (uygulamadaki çağrı noktası). */
  name: string;
  /** PostgREST adresi: `/<tablo>?<sorgu>` (supabase-dart'ın ürettiği). */
  postgrest: string;
  fn: string;
  body?: Record<string, unknown>;
  /**
   * `full`: uygulamanın sırası benzersiz (id ile biter) — dizi sırası da aynı.
   * `none`: sırasız ya da eşitlikte tanımsız — küme olarak.
   */
  order: 'full' | 'none';
  /**
   * Uygulamanın sıralaması eşit değerlerde tanımsızsa (`created_at desc`,
   * tiebreak yok): satırlar küme olarak, bu alanın değer dizisi sıralı olarak
   * karşılaştırılır.
   */
  orderKey?: string;
  /** PagedQuery ile sayfalanan okuma: küçük sayfalarla da aynı sonuç. */
  paged?: boolean;
  /** Tek satır (`maybeSingle`): PostgREST dizisinin ilki ya da null. */
  single?: boolean;
}

const sel = (s: string) => `select=${encodeURIComponent(s)}`;

const ATTENDANCE_SELECT =
  '*,athletes(id,full_name),classes(id,name),branches(id,name),coach:profiles!attendances_coach_id_fkey(id,full_name)';
const FINANCIAL_SELECT =
  '*,customers!left(id,display_name,type,phone,email,athlete_id,athletes!left(id,full_name,class_id,classes!left(id,name,sport_id,sports!left(id,name)))),income_expense_items!left(id,name),branches!left(id,name),transactions!left(id,record_id,amount,method,transaction_date,created_at,is_deleted,processed_by,profiles!left(id,full_name))';

const CASES: ReadCase[] = [
  {
    name: 'athletes_data_source fetchAthletes',
    postgrest: `/athletes?${sel('*,classes(id,name,sports(name)),branches(id,name),parent_athlete_links(profile_id,profiles!inner(full_name,phone_number))')}&order=created_at.asc,id.asc`,
    fn: 'list_athletes',
    order: 'full',
    paged: true,
  },
  {
    name: 'attendances_data_source fetchRosterAthletes',
    postgrest: `/athletes?${sel('id,full_name,class_id,photo_path,approval_status')}&order=created_at.asc,id.asc`,
    fn: 'list_roster_athletes',
    order: 'full',
    paged: true,
  },
  {
    name: 'reminders_data_source _fetchBirthdayCandidates',
    postgrest: `/athletes?${sel('id,full_name,date_of_birth,photo_path')}&approval_status=eq.active&date_of_birth=not.is.null&order=id.asc`,
    fn: 'list_birthday_candidates',
    order: 'full',
    paged: true,
  },
  {
    name: 'reminders_data_source _fetchExpiringRegistrations',
    postgrest: `/athletes?${sel('id,full_name,contract_end_date,photo_path,classes(name,sports(name)),branches(name)')}&approval_status=eq.active&contract_end_date=gte.2027-06-01&contract_end_date=lte.2027-07-30&order=contract_end_date.asc`,
    fn: 'list_expiring_registrations',
    body: { p_from: '2027-06-01', p_to: '2027-07-30' },
    order: 'none',
    orderKey: 'contract_end_date',
  },
  {
    name: 'attendances_data_source fetchAttendances (filtresiz)',
    postgrest: `/attendances?${sel(ATTENDANCE_SELECT)}&attendance_date=gte.2026-09-01&attendance_date=lte.2026-09-30&order=attendance_date.desc,id.asc`,
    fn: 'list_attendances',
    body: { p_start_date: '2026-09-01', p_end_date: '2026-09-30' },
    order: 'full',
    paged: true,
  },
  {
    name: 'attendances_data_source fetchAttendances (şube + sınıf + antrenör)',
    postgrest: `/attendances?${sel(ATTENDANCE_SELECT)}&attendance_date=gte.2026-09-01&attendance_date=lte.2026-09-10&branch_id=eq.${BRANCH_A1}&class_id=eq.a0000000-0000-4000-8000-0000000000d1&coach_id=eq.${A.coach}&order=attendance_date.desc,id.asc`,
    fn: 'list_attendances',
    body: {
      p_start_date: '2026-09-01',
      p_end_date: '2026-09-10',
      p_branch_id: BRANCH_A1,
      p_class_id: 'a0000000-0000-4000-8000-0000000000d1',
      p_coach_id: A.coach,
    },
    order: 'full',
    paged: true,
  },
  {
    name: 'attendances_data_source fetchClassAttendance',
    postgrest: `/attendances?${sel(ATTENDANCE_SELECT)}&class_id=eq.a0000000-0000-4000-8000-0000000000d2&attendance_date=eq.2026-09-07`,
    fn: 'list_attendances',
    body: {
      p_start_date: '2026-09-07',
      p_end_date: '2026-09-07',
      p_class_id: 'a0000000-0000-4000-8000-0000000000d2',
    },
    order: 'none',
  },
  {
    name: 'pre_registration_data_source fetchPreRegistrations',
    postgrest: `/pre_registrations?${sel('*,branches(id,name),classes(id,name,sports(id,name))')}&order=created_at.asc,id.asc`,
    fn: 'list_pre_registrations',
    order: 'full',
    paged: true,
  },
  {
    name: 'parents_data_source fetchParents',
    postgrest: `/profiles?${sel('*,parent_athlete_links(athletes(id,full_name)),profile_branch_links(branch_id)')}&role_id=eq.8&order=created_at.asc,id.asc`,
    fn: 'list_parents',
    order: 'full',
    paged: true,
  },
  {
    name: 'coaches_data_source fetchCoaches',
    postgrest: `/profiles?${sel('*,coach_class_links(class_id,classes(id,name)),profile_branch_links(branch_id,branches(id,name)),profile_permissions!profile_permissions_profile_id_fkey(permission)')}&role_id=eq.4`,
    fn: 'list_coaches',
    order: 'none',
  },
  {
    name: 'users_data_source fetchUsers',
    postgrest: `/profiles?${sel('*,roles(name),profile_branch_links(branch_id),profile_permissions!profile_permissions_profile_id_fkey(permission)')}&role_id=not.in.(4,8)`,
    fn: 'list_users',
    order: 'none',
  },
  {
    name: 'users_data_source fetchRoles',
    postgrest: `/roles?${sel('id,name')}&id=not.in.(4,6,7,8)`,
    fn: 'list_roles',
    body: { p_exclude_ids: [4, 6, 7, 8] },
    order: 'none',
  },
  {
    name: 'permissions_data_source fetchRolePermissions',
    postgrest: `/role_permissions?${sel('role_id,permission,is_optional')}`,
    fn: 'list_role_permissions',
    order: 'none',
  },
  {
    name: 'branch_data_source fetchBranches',
    postgrest: `/branches?${sel('*,profile_branch_links(profiles!inner(*,roles(name)))')}&${encodeURIComponent('profile_branch_links.profiles.role_id')}=in.(1,2,3,9)`,
    fn: 'list_branches',
    order: 'none',
  },
  {
    name: 'classes_data_source fetchClasses',
    postgrest: `/classes?${sel('*,branches(id,name),sports(id,name),athletes(id,full_name),class_schedule_slots(weekday,start_time),coach_class_links(profile_id,profiles(id,full_name,status,role_id,is_deleted))')}`,
    fn: 'list_classes',
    order: 'none',
  },
  {
    name: 'sports_data_source fetchSports',
    postgrest: `/sports?${sel('*,branch_sport_links!left(branches!left(id,name))')}`,
    fn: 'list_sports',
    order: 'none',
  },
  {
    name: 'school_data_source fetchSchool (A)',
    postgrest: `/schools?select=*&id=eq.${SCHOOL_A}`,
    fn: 'get_school',
    body: { p_school_id: SCHOOL_A },
    order: 'none',
    single: true,
  },
  {
    name: 'school_data_source fetchSchool (B)',
    postgrest: `/schools?select=*&id=eq.${SCHOOL_B}`,
    fn: 'get_school',
    body: { p_school_id: SCHOOL_B },
    order: 'none',
    single: true,
  },
  {
    name: 'customers_data_source fetchCustomers (kapsam: income)',
    postgrest: `/customers?${sel('*,athletes!left(id,full_name,class_id,branch_id,classes!left(id,name))')}&type=in.(athlete,external)&order=display_name.asc,id.asc`,
    fn: 'list_customers',
    body: { p_types: ['athlete', 'external'] },
    order: 'full',
    paged: true,
  },
  {
    name: 'customers_data_source fetchCustomers (kapsamsız)',
    postgrest: `/customers?${sel('*,athletes!left(id,full_name,class_id,branch_id,classes!left(id,name))')}&order=display_name.asc,id.asc`,
    fn: 'list_customers',
    order: 'full',
    paged: true,
  },
  {
    name: 'financial_records_data_source fetchRecords (due)',
    postgrest: `/financial_records?${sel(FINANCIAL_SELECT)}&type=eq.due&order=expected_date.desc,id.asc`,
    fn: 'list_financial_records',
    body: { p_type: 'due' },
    order: 'full',
    paged: true,
  },
  {
    name: 'financial_records_data_source fetchRecords (expense)',
    postgrest: `/financial_records?${sel(FINANCIAL_SELECT)}&type=eq.expense&order=expected_date.desc,id.asc`,
    fn: 'list_financial_records',
    body: { p_type: 'expense' },
    order: 'full',
    paged: true,
  },
  {
    name: 'income_expense_items_data_source fetchIncomeExpenseItems',
    postgrest: `/income_expense_items?${sel('*,branch_income_expense_item_links!left(branches!left(id,name))')}`,
    fn: 'list_income_expense_items',
    order: 'none',
  },
  {
    name: 'discounts_data_source fetchDiscounts',
    postgrest: `/discounts?${sel('*,branch_discount_links!left(branches!left(id,name))')}&order=created_at.desc`,
    fn: 'list_discounts',
    order: 'none',
    orderKey: 'created_at',
  },
  {
    name: 'announcements_data_source fetchAnnouncements',
    postgrest: `/notification_announcements?${sel('id,title,body,role_ids,branch_ids,recipient_count,created_at,profiles(full_name)')}&order=created_at.desc&limit=50`,
    fn: 'list_announcements',
    body: { p_limit: 50 },
    order: 'none',
    orderKey: 'created_at',
  },
  {
    name: 'notifications_data_source fetchInbox (Y + V)',
    postgrest: `/notifications?${sel('id,type,params,created_at,read_at')}&order=created_at.desc&limit=50`,
    fn: 'list_notifications',
    body: { p_limit: 50 },
    order: 'none',
    orderKey: 'created_at',
  },
  {
    name: 'notifications_data_source fetchPreferences',
    postgrest: `/notification_preferences?${sel('type,push_enabled')}`,
    fn: 'list_notification_preferences',
    order: 'none',
  },
];

const VIEWERS: [string, string][] = [
  ['A genel müdür', A.generalManager],
  ['A şube müdürü (A1)', A.branchManager],
  ['A müdür yardımcısı (A1)', A.assistant],
  ['A antrenör (A1)', A.coach],
  ['A muhasebeci (A1, A2)', A.accountant],
  ['A veli', A.parent],
  ['A pasif veli', A.passiveParent],
  ['A silinmiş hesap', A.dietician],
  ['B genel müdür', B.generalManager],
  ['B veli', B.parent],
];

describe('Okuma fonksiyonları = PostgREST (S07, gerçek Postgres + PostgREST)', () => {
  let db: TestDatabase;
  let postgrest: TestPostgrest;
  let app: INestApplication<App>;
  let client: Client;

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    client = new Client({ connectionString: db.url });
    await client.connect();
    await client.query(FIXTURES);
    [postgrest, app] = await Promise.all([
      startPostgrest(db),
      createTestApp(db),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await postgrest?.stop();
    await client?.end();
    await db?.stop();
  });

  async function fromPostgrest(path: string, token: string): Promise<Json> {
    const res = await fetch(`${postgrest.url}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as Json;
    if (res.status !== 200) {
      throw new Error(
        `PostgREST ${res.status} ${path}: ${JSON.stringify(body)}`,
      );
    }
    return body;
  }

  async function fromRpc(
    fn: string,
    body: Record<string, unknown>,
    token: string,
  ): Promise<Json> {
    const res = await request(app.getHttpServer())
      .post(`/rpc/${fn}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    if (res.status !== 200) {
      throw new Error(`/rpc/${fn} ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return res.body as Json;
  }

  /** `PagedQuery.fetchAll`'ın yaptığı, verilen sayfa boyutuyla. */
  async function pagedRpc(
    c: ReadCase,
    token: string,
    pageSize: number,
  ): Promise<Json[]> {
    const rows: Json[] = [];
    for (let from = 0; ; from += pageSize) {
      const page = (await fromRpc(
        c.fn,
        { ...c.body, p_offset: from, p_limit: pageSize },
        token,
      )) as Json[];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  describe.each(VIEWERS)('%s', (_label, userId) => {
    const token = supabaseUserToken(userId);

    it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
      const expected = await fromPostgrest(c.postgrest, token);
      const actual = await fromRpc(c.fn, c.body ?? {}, token);
      const want = c.single ? ((expected as Json[])[0] ?? null) : expected;
      expect(canonical(actual, c.order === 'none')).toEqual(
        canonical(want, c.order === 'none'),
      );
      if (c.orderKey) {
        const key = c.orderKey;
        const keys = (rows: Json) =>
          (rows as Record<string, Json>[]).map((r) => r[key]);
        expect(keys(actual)).toEqual(keys(want));
      }
      if (c.paged) {
        const paged = await pagedRpc(c, token, 2);
        expect(canonical(paged, c.order === 'none')).toEqual(
          canonical(want, c.order === 'none'),
        );
      }
    });

    it('notifications_data_source fetchUnreadCount (Y + V)', async () => {
      const res = await fetch(
        `${postgrest.url}/notifications?select=id&read_at=is.null`,
        {
          headers: { Authorization: `Bearer ${token}`, Prefer: 'count=exact' },
        },
      );
      const total = Number(res.headers.get('content-range')?.split('/')[1]);
      expect(await fromRpc('count_unread_notifications', {}, token)).toBe(
        total,
      );
    });

    it('get_notification (S11 Realtime satırı) = PostgREST select=* satırı', async () => {
      for (const id of [
        X.notifParent,
        X.notifManagerRead,
        X.notifManagerUnread,
        X.notifB,
      ]) {
        const rows = (await fromPostgrest(
          `/notifications?select=*&id=eq.${id}`,
          token,
        )) as Json[];
        await client.query('begin');
        try {
          await client.query('set local role authenticated');
          await client.query(
            "select set_config('request.jwt.claims', $1, true)",
            [JSON.stringify({ sub: userId, role: 'authenticated' })],
          );
          const { rows: ours } = await client.query<{ v: Json }>(
            'select public.get_notification($1) as v',
            [id],
          );
          expect(canonical(ours[0].v, true)).toEqual(
            canonical(rows[0] ?? null, true),
          );
        } finally {
          await client.query('rollback');
        }
      }
    });
  });

  /**
   * Eşitlik testi iki taraf da boş dönse de geçer; burada kuralların
   * gerçekten bir şey süzdüğü açıkça yazılı.
   */
  describe('kapsam (açık beklentiler)', () => {
    const names = async (fn: string, userId: string, body = {}) =>
      (
        (await fromRpc(fn, body, supabaseUserToken(userId))) as {
          full_name: string;
        }[]
      )
        .map((r) => r.full_name)
        .sort();

    it('genel müdür kendi okulunun bütün sporcularını görür, silinmişi ve B okulununkini görmez', async () => {
      expect(await names('list_athletes', A.generalManager)).toEqual([
        'Ada Deneme',
        'Deniz Deneme',
        'Ege Deneme',
      ]);
    });

    it('şube müdürü yalnızca kendi şubesinin (A1) sporcularını görür', async () => {
      expect(await names('list_athletes', A.branchManager)).toEqual([
        'Deniz Deneme',
        'Ege Deneme',
      ]);
      const att = (await fromRpc(
        'list_attendances',
        { p_start_date: '2026-09-01', p_end_date: '2026-09-30' },
        supabaseUserToken(A.branchManager),
      )) as { branch_id: string }[];
      expect(att.length).toBe(4);
      expect(new Set(att.map((r) => r.branch_id))).toEqual(
        new Set([BRANCH_A1]),
      );
    });

    it('B okulu A okulundan hiçbir şey görmez', async () => {
      expect(await names('list_athletes', B.generalManager)).toEqual([
        'Mina Örnek',
      ]);
      expect(
        await fromRpc(
          'get_school',
          { p_school_id: SCHOOL_A },
          supabaseUserToken(B.generalManager),
        ),
      ).toBeNull();
      const discounts = (await fromRpc(
        'list_discounts',
        {},
        supabaseUserToken(B.generalManager),
      )) as { id: string }[];
      expect(discounts.map((d) => d.id)).toEqual([X.discountB]);
    });

    it('veli okul tablolarını okuyamaz (parent_no_direct_access), yalnızca kendi bildirimlerini', async () => {
      const parent = supabaseUserToken(A.parent);
      for (const fn of [
        'list_athletes',
        'list_parents',
        'list_classes',
        'list_customers',
      ]) {
        expect(await fromRpc(fn, {}, parent)).toEqual([]);
      }
      const inbox = (await fromRpc('list_notifications', {}, parent)) as {
        id: string;
      }[];
      expect(inbox.map((n) => n.id)).toEqual([X.notifParent]);
      expect(await fromRpc('count_unread_notifications', {}, parent)).toBe(1);
    });

    it('pasif ve silinmiş hesap hiçbir satır görmez', async () => {
      for (const id of [A.passiveParent, A.dietician]) {
        const t = supabaseUserToken(id);
        expect(await fromRpc('list_athletes', {}, t)).toEqual([]);
        expect(await fromRpc('list_notifications', {}, t)).toEqual([]);
        expect(
          await fromRpc('get_school', { p_school_id: SCHOOL_A }, t),
        ).toBeNull();
      }
    });

    it('antrenör finansı görmez (finance.view yok)', async () => {
      expect(
        await fromRpc(
          'list_financial_records',
          { p_type: 'due' },
          supabaseUserToken(A.coach),
        ),
      ).toEqual([]);
    });

    it('anon (oturumsuz) okuma fonksiyonlarını çağıramaz', async () => {
      const res = await request(app.getHttpServer())
        .post('/rpc/list_athletes')
        .set('Authorization', `Bearer ${supabaseAnonKey()}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: '42501' });
    });

    it('yanlış tipte parametre PostgREST gibi 22P02', async () => {
      const res = await request(app.getHttpServer())
        .post('/rpc/list_financial_records')
        .set('Authorization', `Bearer ${supabaseUserToken(A.generalManager)}`)
        .send({ p_type: 'yok_boyle_tur' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: '22P02' });
    });

    it('eşitlik testleri boş değil: genel müdür her okumada satır görür', async () => {
      const t = supabaseUserToken(A.generalManager);
      for (const c of CASES.filter((x) => !x.name.endsWith('(B)'))) {
        const r = await fromRpc(c.fn, c.body ?? {}, t);
        expect({
          fn: c.name,
          empty: Array.isArray(r) ? r.length === 0 : r === null,
        }).toEqual({
          fn: c.name,
          empty: false,
        });
      }
      expect(ATHLETES.deniz).toBeDefined();
    });
  });

  describe('katalog', () => {
    const READS = Object.entries(RPC_ALLOWLIST)
      .filter(([, e]) => e.reads)
      .map(([name]) => name);

    it("her okuma fonksiyonu SECURITY INVOKER, stable, anon'a kapalı ve `backend:` yorumlu", async () => {
      const { rows } = await client.query<{
        proname: string;
        definer: boolean;
        volatile: string;
        anon: boolean;
        auth: boolean;
        comment: string | null;
      }>(
        `select proname, prosecdef as definer, provolatile as volatile,
                has_function_privilege('anon', oid, 'execute') as anon,
                has_function_privilege('authenticated', oid, 'execute') as auth,
                obj_description(oid, 'pg_proc') as comment
           from pg_proc
          where pronamespace = 'public'::regnamespace
            and (proname = any($1) or obj_description(oid, 'pg_proc') like 'backend: S07%')`,
        [[...READS, 'get_notification']],
      );
      expect(rows.map((r) => r.proname).sort()).toEqual(
        [...READS, 'get_notification'].sort(),
      );
      for (const r of rows) {
        expect({
          fn: r.proname,
          definer: r.definer,
          volatile: r.volatile,
          anon: r.anon,
          auth: r.auth,
          backend: r.comment?.startsWith('backend:'),
        }).toEqual({
          fn: r.proname,
          definer: false,
          volatile: 's',
          anon: false,
          auth: true,
          backend: true,
        });
      }
    });

    it("get_notification allow-list'te değil (yalnızca sunucu içi, S11)", () => {
      expect(Object.keys(RPC_ALLOWLIST)).not.toContain('get_notification');
    });
  });
});
