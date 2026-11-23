import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
  mkdir,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskStore } from './disk-store';
import { StorageError } from './storage-errors';

describe('DiskStore', () => {
  let base: string;
  let outside: string;
  let store: DiskStore;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'mso-disk-'));
    outside = await mkdtemp(join(tmpdir(), 'mso-outside-'));
    store = new DiskStore(join(base, 'root'));
    await store.init();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const read = async (bucket: string, key: string) => {
    const file = await store.open(bucket, key);
    if (!file) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  };

  it('geçici dosya → yerine → okunur; dosya 0600', async () => {
    const tmp = await store.writeTemp(Buffer.from('merhaba'));
    await store.place(tmp, 'athlete-photos', 'okul/sporcu/a.jpg');
    expect(await read('athlete-photos', 'okul/sporcu/a.jpg')).toBe('merhaba');
    const info = await stat(
      join(store.root, 'athlete-photos/okul/sporcu/a.jpg'),
    );
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readdir(join(store.root, '.tmp'))).toEqual([]);
  });

  it('geçersiz ad diskte yola dönüşmez', () => {
    expect(() => store.pathFor('athlete-photos', '../x')).toThrow(StorageError);
    expect(() => store.pathFor('..', 'x')).toThrow(StorageError);
    expect(() => store.pathFor('athlete-photos', '/etc/passwd')).toThrow(
      StorageError,
    );
  });

  it('sembolik bağ olan dosyayı açmaz', async () => {
    await writeFile(join(outside, 'gizli'), 'sızmamalı');
    await mkdir(join(store.root, 'athlete-photos/okul'), { recursive: true });
    await symlink(
      join(outside, 'gizli'),
      join(store.root, 'athlete-photos/okul/l.jpg'),
    );
    expect(await store.open('athlete-photos', 'okul/l.jpg')).toBeNull();
  });

  it('sembolik bağ olan klasörden okumaz, oraya yazmaz, kök dışında klasör açmaz', async () => {
    await writeFile(join(outside, 'a.jpg'), 'sızmamalı');
    await mkdir(join(store.root, 'athlete-photos'), { recursive: true });
    await symlink(outside, join(store.root, 'athlete-photos/okul'));
    expect(await store.open('athlete-photos', 'okul/a.jpg')).toBeNull();

    const tmp = await store.writeTemp(Buffer.from('x'));
    await expect(
      store.place(tmp, 'athlete-photos', 'okul/yeni/b.jpg'),
    ).rejects.toThrow(StorageError);
    expect(await readdir(outside)).toEqual(['a.jpg']);
    expect(await store.moveToTrash('athlete-photos', 'okul/a.jpg')).toBeNull();
    expect(await readFile(join(outside, 'a.jpg'), 'utf8')).toBe('sızmamalı');
  });

  it('dosya-klasör çakışması geçersiz ad sayılır', async () => {
    const t1 = await store.writeTemp(Buffer.from('1'));
    await store.place(t1, 'b', 'a/b');
    const t2 = await store.writeTemp(Buffer.from('2'));
    await expect(store.place(t2, 'b', 'a/b/c')).rejects.toThrow(StorageError);
  });

  it('çöp: geri al ve boşalt', async () => {
    const tmp = await store.writeTemp(Buffer.from('x'));
    await store.place(tmp, 'b', 'o/f.jpg');
    const entry = await store.moveToTrash('b', 'o/f.jpg');
    expect(entry).not.toBeNull();
    expect(await store.open('b', 'o/f.jpg')).toBeNull();
    await store.restore(entry!);
    expect(await read('b', 'o/f.jpg')).toBe('x');

    const again = await store.moveToTrash('b', 'o/f.jpg');
    await store.purge(again!);
    expect(await store.open('b', 'o/f.jpg')).toBeNull();
    expect(await store.moveToTrash('b', 'o/yok.jpg')).toBeNull();
  });

  it('açılış temizliği: eski geçici dosyalar silinir, çöp satıra göre geri konur ya da silinir', async () => {
    const tmpOld = await store.writeTemp(Buffer.from('eski'));
    const tmpNew = await store.writeTemp(Buffer.from('yeni'));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(tmpOld, old, old);

    for (const key of ['o/kalan.jpg', 'o/silinen.jpg']) {
      const t = await store.writeTemp(Buffer.from(key));
      await store.place(t, 'b', key);
    }
    const kept = (await store.moveToTrash('b', 'o/kalan.jpg'))!;
    const gone = (await store.moveToTrash('b', 'o/silinen.jpg'))!;
    await utimes(kept, old, old);
    await utimes(gone, old, old);

    const result = await store.sweep(
      (_b, key) => Promise.resolve(key === 'o/kalan.jpg'),
      10 * 60 * 1000,
    );
    expect(result).toEqual({ tmpRemoved: 1, trashPurged: 1, trashRestored: 1 });
    expect(await readdir(join(store.root, '.tmp'))).toEqual([
      tmpNew.split('/').pop(),
    ]);
    expect(await read('b', 'o/kalan.jpg')).toBe('o/kalan.jpg');
    expect(await store.open('b', 'o/silinen.jpg')).toBeNull();
  });
});
