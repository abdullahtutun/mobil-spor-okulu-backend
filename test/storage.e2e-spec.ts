import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type RequestListener,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { StorageService } from '../src/storage/storage.service';
import { ATHLETES, SCHOOL_A, SCHOOL_B, USERS } from './fixtures/seed-ids';
import { createTestApp } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';
import {
  supabaseAnonKey,
  supabaseServiceRoleKey,
  supabaseUserToken,
} from './support/tokens';

const PHOTOS = 'athlete-photos';
const LOGOS = 'school-logos';

const jpeg = (size = 2048) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size)]);
const png = (size = 2048) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(size),
  ]);

/** Uygulamaların fotoğraf yolu: `<okul>/<sporcu>/<sürüm>.jpg`. */
const photoPath = (athlete: string, school = SCHOOL_A) =>
  `${school}/${athlete}/${randomUUID()}.jpg`;
const thumbOf = (path: string) => path.replace(/\.jpg$/, '_thumb.jpg');

/**
 * Dart `http` paketinin MultipartRequest'i — storage_client'ın
 * `uploadBinary`'si tam olarak bunu yollar (alanlar önce, dosya parçası
 * `name=""; filename=""`, `x-upsert` başlığı).
 */
function dartMultipart(
  file: Buffer,
  contentType: string,
  cacheControl: string,
) {
  const boundary = `dart-http-boundary-${randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="cacheControl"\r\n\r\n${cacheControl}\r\n` +
        `--${boundary}\r\ncontent-type: ${contentType}\r\ncontent-disposition: form-data; name=""; filename=""\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  json: () => Record<string, unknown>;
}

describe('Dosya deposu (S08, gerçek Postgres + disk)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;
  let pg: Client;
  let root: string;

  const t = {
    gm: supabaseUserToken(USERS.a.generalManager),
    bm: supabaseUserToken(USERS.a.branchManager),
    coach: supabaseUserToken(USERS.a.coach),
    coach2: supabaseUserToken(USERS.a.coach2),
    accountant: supabaseUserToken(USERS.a.accountant),
    parent: supabaseUserToken(USERS.a.parent),
    passiveParent: supabaseUserToken(USERS.a.passiveParent),
    gmB: supabaseUserToken(USERS.b.generalManager),
    parentB: supabaseUserToken(USERS.b.parent),
  };

  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  const reply = async (req: request.Test): Promise<Reply> => {
    const res = await binary(req);
    const body = res.body as Buffer;
    return {
      status: res.status,
      headers: res.headers,
      body,
      json: () => JSON.parse(body.toString('utf8')) as Record<string, unknown>,
    };
  };

  const upload = (
    bucket: string,
    path: string,
    file: Buffer,
    token: string | undefined,
    options: {
      type?: string;
      upsert?: boolean;
      cacheControl?: string;
      method?: 'post' | 'put';
      rawPath?: boolean;
    } = {},
  ) => {
    const { body, type } = dartMultipart(
      file,
      options.type ?? (bucket === LOGOS ? 'image/png' : 'image/jpeg'),
      options.cacheControl ?? (bucket === LOGOS ? '3600' : '31536000'),
    );
    const url = `/storage/object/${bucket}/${path}`;
    const req = request(app.getHttpServer())
      [options.method ?? 'post'](url)
      .set('Content-Type', type)
      .set('x-upsert', String(options.upsert ?? false));
    if (token) req.set('Authorization', `Bearer ${token}`);
    return reply(req.send(body));
  };

  const download = (
    bucket: string,
    path: string,
    token?: string,
    route: 'plain' | 'public' | 'authenticated' = 'plain',
    headers: Record<string, string> = {},
  ) => {
    const prefix = route === 'plain' ? '' : `${route}/`;
    const req = request(app.getHttpServer()).get(
      `/storage/object/${prefix}${bucket}/${path}`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return reply(req);
  };

  const remove = async (bucket: string, names: unknown, token?: string) => {
    const req = request(app.getHttpServer())
      .delete(`/storage/object/${bucket}`)
      .set('Content-Type', 'application/json');
    if (token) req.set('Authorization', `Bearer ${token}`);
    const res = await req.send(JSON.stringify({ prefixes: names }));
    return { status: res.status, body: res.body as unknown };
  };

  /** Content-Length'siz, parça parça gönderilen gövde (node:http ile). */
  const chunkedPost = async (
    path: string,
    headers: Record<string, string>,
    chunks: Buffer[],
  ): Promise<Reply> => {
    // Ayrı bir sunucu (uygulamanınki supertest'e kalsın), aynı Express.
    const server = createServer(
      app.getHttpAdapter().getInstance() as RequestListener,
    ).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const { port } = server.address() as AddressInfo;
      return await new Promise<Reply>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path, method: 'POST', headers },
          (res) => {
            const parts: Buffer[] = [];
            res.on('data', (c: Buffer) => parts.push(c));
            res.on('end', () => {
              const body = Buffer.concat(parts);
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers as Record<string, string>,
                body,
                json: () =>
                  JSON.parse(body.toString('utf8')) as Record<string, unknown>,
              });
            });
          },
        );
        req.on('error', reject);
        for (const chunk of chunks) req.write(chunk);
        req.end();
      });
    } finally {
      server.close();
    }
  };

  /** storage-api gibi: HTTP 400, sınıf gövdede. */
  const expectError = (res: Reply, statusCode: string, error: string) => {
    expect({ status: res.status, ...res.json() }).toMatchObject({
      status: 400,
      statusCode,
      error,
    });
  };

  const fileOf = (bucket: string, path: string) => join(root, bucket, path);
  const rowOf = async (bucket: string, path: string) =>
    (
      await pg.query<{
        id: string;
        owner: string | null;
        owner_id: string | null;
        metadata: Record<string, unknown>;
        user_metadata: unknown;
        version: string;
      }>(
        'select id, owner, owner_id, metadata, user_metadata, version from storage.objects where bucket_id = $1 and name = $2',
        [bucket, path],
      )
    ).rows[0];
  const tmpEmpty = () => {
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);
    expect(readdirSync(join(root, '.trash'))).toEqual([]);
  };

  // Ek sporcular: silinmiş (Silik) ve sonradan silinecek (Can), ikisi de A1.
  const SILIK = 'a0000000-0000-4000-8000-000000000109';
  const CAN = 'a0000000-0000-4000-8000-00000000010a';

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    app = await createTestApp(db);
    root = app.get(StorageService).store.root;
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    await pg.query(
      `insert into public.athletes (id, branch_id, gender, date_of_birth, registration_date,
         contract_end_date, approval_status, school_id, class_id, full_name, is_deleted)
       select x.id, a.branch_id, a.gender, a.date_of_birth, a.registration_date,
              a.contract_end_date, a.approval_status, a.school_id, a.class_id, x.name, x.deleted
         from public.athletes a,
              (values ($1::uuid, 'Silik Deneme', true), ($2::uuid, 'Can Deneme', false)) x(id, name, deleted)
        where a.id = $3`,
      [SILIK, CAN, ATHLETES.deniz],
    );
    // Veli fotoğraf rızası vermiş (set_athlete_photo bunu ister).
    await pg.query(
      'update public.athletes set photo_consent_at = now() where id = $1',
      [ATHLETES.deniz],
    );
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
    await db?.stop();
  });

  describe('athlete-photos (private)', () => {
    const full = photoPath(ATHLETES.deniz);
    const thumb = thumbOf(full);
    const fullBytes = jpeg(4096);
    const thumbBytes = jpeg(512);
    const egePath = photoPath(ATHLETES.ege);
    const canPath = photoPath(CAN);

    it('athlete_photos_insert: genel müdür uygulamanın biçimiyle yükler; satır canlıdakiyle aynı biçimde', async () => {
      const res = await upload(PHOTOS, full, fullBytes, t.gm);
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.Key).toBe(`${PHOTOS}/${full}`);
      expect(typeof body.Id).toBe('string');

      const row = await rowOf(PHOTOS, full);
      expect(row.id).toBe(body.Id);
      expect(row.owner).toBe(USERS.a.generalManager);
      expect(row.owner_id).toBe(USERS.a.generalManager);
      expect(row.user_metadata).toEqual({});
      expect(row.version).toMatch(/^[0-9a-f-]{36}$/);
      // Canlıdaki 15 nesnenin metadata anahtarları ve biçimleri.
      expect(Object.keys(row.metadata).sort()).toEqual([
        'cacheControl',
        'contentLength',
        'eTag',
        'httpStatusCode',
        'lastModified',
        'mimetype',
        'size',
      ]);
      expect(row.metadata).toMatchObject({
        size: fullBytes.length,
        contentLength: fullBytes.length,
        mimetype: 'image/jpeg',
        cacheControl: 'max-age=31536000',
        httpStatusCode: 200,
      });
      expect(String(row.metadata.eTag)).toHaveLength(34);
      expect(String(row.metadata.lastModified)).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );

      const onDisk = fileOf(PHOTOS, full);
      expect(readFileSync(onDisk).equals(fullBytes)).toBe(true);
      expect(statSync(onDisk).mode & 0o777).toBe(0o600);
      tmpEmpty();
    });

    it('şube müdürü kendi şubesindeki sporcuya yükler; set_athlete_photo iki dosyayı görür', async () => {
      expect((await upload(PHOTOS, thumb, thumbBytes, t.bm)).status).toBe(200);
      const rpc = await request(app.getHttpServer())
        .post('/rpc/set_athlete_photo')
        .set('Authorization', `Bearer ${t.bm}`)
        .send({ p_athlete_id: ATHLETES.deniz, p_photo_path: full })
        .expect(200);
      expect(rpc.body).toMatchObject({
        success: true,
        data: { photo_path: full },
      });
    });

    it.each([
      [
        'başka şubenin sporcusu (şube müdürü → A2)',
        () => t.bm,
        () => photoPath(ATHLETES.ada),
      ],
      [
        'registration.manage yok (antrenör)',
        () => t.coach,
        () => photoPath(ATHLETES.deniz),
      ],
      [
        'registration.manage yok (muhasebeci)',
        () => t.accountant,
        () => photoPath(ATHLETES.deniz),
      ],
      [
        'veli kendi çocuğuna bile',
        () => t.parent,
        () => photoPath(ATHLETES.deniz),
      ],
      [
        'başka okul (B genel müdürü → A)',
        () => t.gmB,
        () => photoPath(ATHLETES.deniz),
      ],
      [
        'başka okulun klasörü (A genel müdürü → B)',
        () => t.gm,
        () => photoPath(ATHLETES.mina, SCHOOL_B),
      ],
      ['silinmiş sporcu', () => t.gm, () => photoPath(SILIK)],
      [
        'yanlış klasör derinliği',
        () => t.gm,
        () => `${SCHOOL_A}/${randomUUID()}.jpg`,
      ],
      ['oturumsuz', () => undefined, () => photoPath(ATHLETES.deniz)],
      [
        'anon anahtarı',
        () => supabaseAnonKey(),
        () => photoPath(ATHLETES.deniz),
      ],
    ])('athlete_photos_insert reddeder: %s', async (_, token, path) => {
      const p = path();
      const res = await upload(PHOTOS, p, jpeg(), token());
      expectError(res, '403', 'Unauthorized');
      expect(res.json().message).toBe(
        'new row violates row-level security policy',
      );
      expect(await rowOf(PHOTOS, p)).toBeUndefined();
      expect(existsSync(fileOf(PHOTOS, p))).toBe(false);
      tmpEmpty();
    });

    it('üzerine yazılmaz: aynı ad 409, x-upsert ve PUT 403 (UPDATE politikası yok); dosya değişmez', async () => {
      expectError(await upload(PHOTOS, full, jpeg(), t.gm), '409', 'Duplicate');
      expectError(
        await upload(PHOTOS, full, jpeg(), t.gm, { upsert: true }),
        '403',
        'Unauthorized',
      );
      expectError(
        await upload(PHOTOS, full, jpeg(), t.gm, { method: 'put' }),
        '403',
        'Unauthorized',
      );
      expect(readFileSync(fileOf(PHOTOS, full)).equals(fullBytes)).toBe(true);
      tmpEmpty();
    });

    it('athlete_photos_select: personel okur; başlıklar storage-api gibi; If-None-Match → 304', async () => {
      const res = await download(PHOTOS, full, t.gm);
      expect(res.status).toBe(200);
      expect(res.body.equals(fullBytes)).toBe(true);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('max-age=31536000');
      expect(res.headers['content-length']).toBe(String(fullBytes.length));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers.etag).toHaveLength(34);
      expect(res.headers['last-modified']).toMatch(/GMT$/);

      const authed = await download(PHOTOS, full, t.gm, 'authenticated');
      expect(authed.body.equals(fullBytes)).toBe(true);

      const cached = await download(PHOTOS, full, t.gm, 'plain', {
        'If-None-Match': res.headers.etag,
      });
      expect(cached.status).toBe(304);
      expect(cached.body.length).toBe(0);
    });

    it.each([
      ['şube müdürü (A1)', () => t.bm],
      ['antrenör (A1)', () => t.coach],
      ['veli, kendi çocuğu', () => t.parent],
    ])('athlete_photos_select izin verir: %s', async (_, token) => {
      const res = await download(PHOTOS, thumb, token());
      expect(res.status).toBe(200);
      expect(res.body.equals(thumbBytes)).toBe(true);
    });

    it('Ege’nin fotoğrafı (pasif velinin çocuğu) yüklenir', async () => {
      expect((await upload(PHOTOS, egePath, jpeg(), t.gm)).status).toBe(200);
    });

    it.each([
      ['başka şubenin antrenörü (A2)', () => t.coach2, () => full],
      ['veli, başkasının çocuğu', () => t.parent, () => egePath],
      ['pasif veli, kendi çocuğu', () => t.passiveParent, () => egePath],
      ['başka okulun velisi', () => t.parentB, () => full],
      ['başka okulun genel müdürü', () => t.gmB, () => full],
      ['olmayan dosya', () => t.gm, () => photoPath(ATHLETES.deniz)],
    ])(
      'athlete_photos_select reddeder (NoSuchKey): %s',
      async (_, token, path) => {
        const res = await download(PHOTOS, path(), token());
        expectError(res, '404', 'not_found');
        expect(res.body.includes(fullBytes.subarray(0, 64))).toBe(false);
      },
    );

    it('oturumsuz ve public uçtan private bucket: "bucket yok"', async () => {
      expectError(await download(PHOTOS, full), '404', 'Bucket not found');
      expectError(
        await download(PHOTOS, full, t.gm, 'public'),
        '404',
        'Bucket not found',
      );
      expectError(
        await download(PHOTOS, full, supabaseAnonKey()),
        '404',
        'Bucket not found',
      );
    });

    it('silinen sporcunun fotoğrafını kimse okuyamaz ve personel silemez', async () => {
      expect((await upload(PHOTOS, canPath, jpeg(), t.gm)).status).toBe(200);
      expect((await download(PHOTOS, canPath, t.gm)).status).toBe(200);
      await pg.query(
        'update public.athletes set is_deleted = true where id = $1',
        [CAN],
      );
      expectError(await download(PHOTOS, canPath, t.gm), '404', 'not_found');
      expect((await remove(PHOTOS, [canPath], t.gm)).body).toEqual([]);
      expect(existsSync(fileOf(PHOTOS, canPath))).toBe(true);
    });

    it('athlete_photos_delete: yetkisiz personelin silmesi sessizce düşer, dosya durur', async () => {
      for (const token of [t.coach, t.accountant, t.coach2, t.gmB]) {
        const res = await remove(PHOTOS, [full, thumb], token);
        expect(res).toEqual({ status: 200, body: [] });
      }
      expect(existsSync(fileOf(PHOTOS, full))).toBe(true);
      expect(await rowOf(PHOTOS, full)).toBeDefined();
    });

    it('athlete_photos_parent_delete: veli rıza dururken silemez', async () => {
      // set_athlete_photo photo_path'i yazdı, rıza var.
      expect((await remove(PHOTOS, [full, thumb], t.parent)).body).toEqual([]);
      expect(existsSync(fileOf(PHOTOS, full))).toBe(true);
    });

    it('athlete_photos_parent_delete: rıza geri alınınca veli yalnızca kendi çocuğunun fotoğrafını siler', async () => {
      // parent_set_consents'in geri almada yaptığı: rıza ve yol temizlenir.
      await pg.query(
        'update public.athletes set photo_consent_at = null, photo_path = null where id = any($1)',
        [[ATHLETES.deniz, ATHLETES.ege]],
      );
      // Başkasının çocuğu ve pasif velinin kendi çocuğu: düşer.
      expect((await remove(PHOTOS, [egePath], t.parent)).body).toEqual([]);
      expect((await remove(PHOTOS, [egePath], t.passiveParent)).body).toEqual(
        [],
      );
      expect(existsSync(fileOf(PHOTOS, egePath))).toBe(true);

      const res = await remove(
        PHOTOS,
        [full, thumb, 'olmayan/ad.jpg', '../../etc/passwd'],
        t.parent,
      );
      expect(res.status).toBe(200);
      const rows = res.body as Record<string, unknown>[];
      expect(rows.map((r) => r.name).sort()).toEqual([full, thumb].sort());
      expect(rows[0]).toMatchObject({ bucket_id: PHOTOS });
      expect(rows[0]).not.toHaveProperty('path_tokens');
      expect(existsSync(fileOf(PHOTOS, full))).toBe(false);
      expect(existsSync(fileOf(PHOTOS, thumb))).toBe(false);
      expect(await rowOf(PHOTOS, full)).toBeUndefined();
      tmpEmpty();
      expect((await remove(PHOTOS, [full], t.parent)).body).toEqual([]);
    });

    it('athlete_photos_delete: yetkili personel siler (satır + dosya)', async () => {
      const res = await remove(PHOTOS, [egePath], t.bm);
      expect((res.body as unknown[]).length).toBe(1);
      expect(existsSync(fileOf(PHOTOS, egePath))).toBe(false);
      tmpEmpty();
    });
  });

  describe('school-logos (public)', () => {
    const logo = `${SCHOOL_A}/logo.png`;
    const first = png(3000);
    const second = png(1000);
    let firstId: string;

    it('school_logos_admin_insert: genel müdür yönetim uygulaması gibi (upsert) yükler', async () => {
      const res = await upload(LOGOS, logo, first, t.gm, { upsert: true });
      expect(res.status).toBe(200);
      firstId = String(res.json().Id);
      expect((await rowOf(LOGOS, logo)).metadata).toMatchObject({
        mimetype: 'image/png',
        cacheControl: 'max-age=3600',
      });
    });

    it('school_logos_public_read: oturumsuz okunur (getPublicUrl biçimi, ?v= sürümüyle)', async () => {
      const res = await download(
        LOGOS,
        `${logo}?v=1732300000000`,
        undefined,
        'public',
      );
      expect(res.status).toBe(200);
      expect(res.body.equals(first)).toBe(true);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('max-age=3600');
      // Oturumlu uçtan da (politika `to public`): veli, başka okul.
      expect((await download(LOGOS, logo, t.parent)).body.equals(first)).toBe(
        true,
      );
      expect((await download(LOGOS, logo, t.parentB)).body.equals(first)).toBe(
        true,
      );
      expect((await download(LOGOS, logo)).status).toBe(200);
    });

    it.each([
      ['school.manage yok (şube müdürü)', () => t.bm, `${SCHOOL_A}/logo.png`],
      ['başka okulun klasörü (A → B)', () => t.gm, `${SCHOOL_B}/logo.png`],
      ['başka okul (B → A)', () => t.gmB, `${SCHOOL_A}/logo2.png`],
      ['oturumsuz', () => undefined, `${SCHOOL_A}/logo3.png`],
    ])(
      'school_logos_admin_insert/update reddeder: %s',
      async (_, token, path) => {
        const res = await upload(LOGOS, path, png(), token(), { upsert: true });
        expectError(res, '403', 'Unauthorized');
        expect(
          (await download(LOGOS, logo, undefined, 'public')).body.equals(first),
        ).toBe(true);
        tmpEmpty();
      },
    );

    it('school_logos_admin_update: genel müdür üzerine yazar (aynı satır, yeni ETag); upsertsiz 409', async () => {
      const before = await download(LOGOS, logo, undefined, 'public');
      const res = await upload(LOGOS, logo, second, t.gm, { upsert: true });
      expect(res.status).toBe(200);
      expect(res.json().Id).toBe(firstId);
      const after = await download(LOGOS, logo, undefined, 'public');
      expect(after.body.equals(second)).toBe(true);
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expectError(await upload(LOGOS, logo, png(), t.gm), '409', 'Duplicate');
      tmpEmpty();
    });

    it('school_logos_admin_delete: yalnızca kendi okulunun school.manage sahibi siler', async () => {
      expect((await remove(LOGOS, [logo], t.bm)).body).toEqual([]);
      expect((await remove(LOGOS, [logo], t.gmB)).body).toEqual([]);
      expect((await remove(LOGOS, [logo])).body).toEqual([]);
      expect((await download(LOGOS, logo, undefined, 'public')).status).toBe(
        200,
      );

      const res = await remove(LOGOS, [logo], t.gm);
      expect((res.body as unknown[]).length).toBe(1);
      expectError(
        await download(LOGOS, logo, undefined, 'public'),
        '404',
        'not_found',
      );
      expect(existsSync(fileOf(LOGOS, logo))).toBe(false);
    });

    it('bilinmeyen bucket', async () => {
      expectError(
        await download('yok', 'a/b.png', undefined, 'public'),
        '404',
        'Bucket not found',
      );
      expectError(
        await upload('yok', 'a/b.png', png(), t.gm),
        '404',
        'Bucket not found',
      );
    });
  });

  describe('güvenlik', () => {
    it.each([
      `${SCHOOL_A}/%2E%2E/%2E%2E/x.jpg`,
      `${SCHOOL_A}/..%2F..%2Fx.jpg`,
      `${SCHOOL_A}/${ATHLETES.deniz}/a%00.jpg`,
      `${SCHOOL_A}/${ATHLETES.deniz}/a%5C..%5Cb.jpg`,
      `/${SCHOOL_A}/${ATHLETES.deniz}/a.jpg`,
      `${SCHOOL_A}/${ATHLETES.deniz}/.gizli.jpg`,
      `${SCHOOL_A}/${ATHLETES.deniz}/%C3%A7.jpg`,
    ])('yol saldırısı reddedilir: %s', async (path) => {
      expectError(
        await upload(PHOTOS, path, jpeg(), t.gm),
        '400',
        'InvalidKey',
      );
      expectError(await download(PHOTOS, path, t.gm), '400', 'InvalidKey');
      tmpEmpty();
      // Kökün dışına hiçbir şey yazılmadı.
      expect(
        readdirSync(join(root, '..')).filter((n) => n === 'x.jpg'),
      ).toEqual([]);
    });

    it('bozuk yüzde kodlaması 400 ile reddedilir (Express yönlendiricide)', async () => {
      const path = `${SCHOOL_A}/${ATHLETES.deniz}/%E0%A4%A.jpg`;
      expect((await upload(PHOTOS, path, jpeg(), t.gm)).status).toBe(400);
      expect((await download(PHOTOS, path, t.gm)).status).toBe(400);
      tmpEmpty();
    });

    it('bucket sınırından büyük dosya 413 (Content-Length ve gerçek gövde)', async () => {
      const path = photoPath(ATHLETES.deniz);
      const res = await upload(PHOTOS, path, jpeg(1024 * 1024), t.gm);
      expectError(res, '413', 'Payload too large');
      expect(await rowOf(PHOTOS, path)).toBeUndefined();

      // Content-Length yok (chunked, parça parça): okurken kesilir; kalan
      // gövde okunup atılır ve istemci 413'ü okuyabilir (bağlantı kopmaz).
      const res2 = await chunkedPost(
        `/storage/object/${PHOTOS}/${path}`,
        { Authorization: `Bearer ${t.gm}`, 'Content-Type': 'image/jpeg' },
        [jpeg(512 * 1024), randomBytes(512 * 1024), randomBytes(64 * 1024)],
      );
      expectError(res2, '413', 'Payload too large');
      tmpEmpty();
    });

    it('türü bucket’ın listesinde değil ya da gövde bildirilen türde değil → 415', async () => {
      const path = photoPath(ATHLETES.deniz);
      expectError(
        await upload(PHOTOS, path, png(), t.gm, { type: 'image/png' }),
        '415',
        'invalid_mime_type',
      );
      expectError(
        await upload(PHOTOS, path, png(), t.gm),
        '415',
        'invalid_mime_type',
      );
      expectError(
        await upload(
          PHOTOS,
          path,
          Buffer.from('<html><script>alert(1)</script>'),
          t.gm,
        ),
        '415',
        'invalid_mime_type',
      );
      expectError(
        await upload(PHOTOS, path, jpeg(), t.gm, { type: 'text/html' }),
        '415',
        'invalid_mime_type',
      );
      expect(await rowOf(PHOTOS, path)).toBeUndefined();
      tmpEmpty();
    });

    it('ham gövdeyle (multipart olmadan) yükleme de çalışır', async () => {
      const path = `${SCHOOL_A}/logo.png`;
      const bytes = png();
      const res = await reply(
        request(app.getHttpServer())
          .post(`/storage/object/${LOGOS}/${path}`)
          .set('Authorization', `Bearer ${t.gm}`)
          .set('Content-Type', 'image/png')
          .set('Cache-Control', 'max-age=60')
          .send(bytes),
      );
      expect(res.status).toBe(200);
      const got = await download(LOGOS, path, undefined, 'public');
      expect(got.body.equals(bytes)).toBe(true);
      expect(got.headers['cache-control']).toBe('max-age=60');
    });

    it('diskte sembolik bağa dönüşmüş nesne sunulmaz', async () => {
      const secret = join(tmpdir(), `mso-secret-${randomUUID()}`);
      await writeFile(secret, 'SIR-ICERIK');
      const name = `${SCHOOL_A}/${ATHLETES.deniz}/${randomUUID()}.jpg`;
      await pg.query(
        `insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{"mimetype":"image/jpeg"}')`,
        [PHOTOS, name],
      );
      await mkdir(join(root, PHOTOS, SCHOOL_A, ATHLETES.deniz), {
        recursive: true,
      });
      await symlink(secret, fileOf(PHOTOS, name));
      const res = await download(PHOTOS, name, t.gm);
      expectError(res, '404', 'not_found');
      expect(res.body.toString()).not.toContain('SIR-ICERIK');
    });

    it('token hataları 401 ve PostgREST kodu (uygulama token yeniler)', async () => {
      const path = photoPath(ATHLETES.deniz);
      const expired = supabaseUserToken(USERS.a.generalManager, {
        expiresInSec: -10,
      });
      for (const res of [
        await upload(PHOTOS, path, jpeg(), expired),
        await download(PHOTOS, path, expired),
      ]) {
        expect(res.status).toBe(401);
        expect(res.json()).toMatchObject({
          statusCode: '401',
          code: 'PGRST303',
          message: 'JWT expired',
        });
      }
      const service = await upload(
        PHOTOS,
        path,
        jpeg(),
        supabaseServiceRoleKey(),
      );
      expect(service.status).toBe(401);
      expect(await rowOf(PHOTOS, path)).toBeUndefined();
    });

    it('silme gövdesi doğrulanır', async () => {
      const bad = await request(app.getHttpServer())
        .delete(`/storage/object/${PHOTOS}`)
        .set('Authorization', `Bearer ${t.gm}`)
        .send({});
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({
        statusCode: '400',
        error: 'InvalidRequest',
      });
      const many = await remove(
        PHOTOS,
        Array.from({ length: 1001 }, (_, i) => `a/${i}.jpg`),
        t.gm,
      );
      expect(many.status).toBe(400);
      const wrongType = await remove(PHOTOS, [1, 2], t.gm);
      expect(wrongType.status).toBe(400);
    });

    it('CORS: tarayıcı yükleme başlıklarıyla PUT/POST yapabilir', async () => {
      const res = await request(app.getHttpServer())
        .options(`/storage/object/${LOGOS}/${SCHOOL_A}/logo.png`)
        .set('Origin', 'https://yonetim.mobilsporokulu.com')
        .set('Access-Control-Request-Method', 'PUT')
        .set(
          'Access-Control-Request-Headers',
          'authorization,x-upsert,content-type',
        );
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-methods']).toContain('PUT');
      expect(res.headers['access-control-allow-headers']).toContain('x-upsert');
    });
  });
});
