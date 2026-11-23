import { randomUUID } from 'node:crypto';
import { constants, type ReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { isValidBucketId, isValidObjectKey } from './object-key';
import { StorageError } from './storage-errors';

/** Çöp kutusundaki bir girdinin hangi nesneye ait olduğu. */
interface TrashRef {
  bucket: string;
  key: string;
}

export interface OpenedFile {
  stream: ReadStream;
  size: number;
}

export interface SweepResult {
  tmpRemoved: number;
  trashPurged: number;
  trashRestored: number;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Dosya baytlarının diskteki yeri (K9): `<root>/<bucket>/<ad>`.
 *
 *   <root>/.tmp/<uuid>              yüklemenin geçici dosyası
 *   <root>/.trash/<uuid>/file       silinmekte olan dosya
 *   <root>/.trash/<uuid>/ref.json   …ve hangi nesne olduğu
 *
 * Güvenlik:
 *   - Ad ve bucket `object-key.ts`'in kuralından geçmeden yol olmaz; `..`,
 *     `.` ile başlayan parça, boş parça yoktur. Yol yine de `<root>/<bucket>/`
 *     altında mı diye ayrıca bakılır.
 *   - Kök açılışta `realpath`'lenir; her işlemde dosyanın klasörünün gerçek
 *     yolu sözlük yoluyla aynı olmalı — yani kökün altında hiçbir sembolik
 *     bağ izlenmez. Dosyanın kendisi `O_NOFOLLOW` ile açılır.
 *   - Klasörler 0700, dosyalar 0600 (yalnızca API kullanıcısı).
 *
 * Bu sınıf yetki kararı vermez; o `storage.objects` politikalarının işi
 * (StorageService her disk işleminden önce satırı isteğin rolüyle okur/yazar).
 */
export class DiskStore {
  private rootPath?: string;

  constructor(private readonly configuredRoot: string) {}

  get root(): string {
    if (!this.rootPath) throw new Error('DiskStore.init çağrılmadı.');
    return this.rootPath;
  }

  async init(): Promise<void> {
    await mkdir(this.configuredRoot, { recursive: true, mode: DIR_MODE });
    this.rootPath = await realpath(this.configuredRoot);
    await mkdir(join(this.rootPath, '.tmp'), {
      recursive: true,
      mode: DIR_MODE,
    });
    await mkdir(join(this.rootPath, '.trash'), {
      recursive: true,
      mode: DIR_MODE,
    });
  }

  /** Nesnenin dosya yolu; ad/bucket geçersizse hata (asla kök dışı yol yok). */
  pathFor(bucket: string, key: string): string {
    if (!isValidBucketId(bucket) || !isValidObjectKey(key)) {
      throw StorageError.invalidKey(key);
    }
    const bucketDir = join(this.root, bucket);
    const path = join(bucketDir, ...key.split('/'));
    if (!path.startsWith(bucketDir + sep)) throw StorageError.invalidKey(key);
    return path;
  }

  /** Gövdeyi geçici dosyaya yazar (yeni ad, `wx`: var olanın üzerine değil). */
  async writeTemp(bytes: Buffer): Promise<string> {
    const path = join(this.root, '.tmp', randomUUID());
    await writeFile(path, bytes, { flag: 'wx', mode: FILE_MODE });
    return path;
  }

  /** Geçici dosyayı nesnenin yerine taşır (aynı dosya sistemi: atomik). */
  async place(tmpPath: string, bucket: string, key: string): Promise<void> {
    const path = this.pathFor(bucket, key);
    const parent = dirname(path);
    await this.ensureDir(parent, key);
    await this.assertNoSymlinks(parent, key);
    try {
      await rename(tmpPath, path);
    } catch (error) {
      if (isFsError(error, 'EISDIR', 'ENOTEMPTY', 'EEXIST')) {
        throw StorageError.invalidKey(key);
      }
      throw error;
    }
  }

  /** Nesnenin dosyasını açar; yoksa `null`. Sembolik bağ açılmaz. */
  async open(bucket: string, key: string): Promise<OpenedFile | null> {
    const path = this.pathFor(bucket, key);
    try {
      await this.assertNoSymlinks(dirname(path), key);
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          await handle.close();
          return null;
        }
        // Akış tanıtıcının sahibi olur ve bitince kapatır.
        const stream = handle.createReadStream({ autoClose: true });
        return { stream, size: info.size };
      } catch (error) {
        await handle.close();
        throw error;
      }
    } catch (error) {
      if (error instanceof StorageError) return null;
      // ELOOP: dosyanın kendisi sembolik bağ (O_NOFOLLOW).
      if (isFsError(error, 'ENOENT', 'ENOTDIR', 'ELOOP')) return null;
      throw error;
    }
  }

  /**
   * Dosyayı çöpe taşır (silme transaction'ı açıkken). Dosya yoksa `null`.
   * Transaction geri alınırsa `restore`, commit olursa `purge`.
   */
  async moveToTrash(bucket: string, key: string): Promise<string | null> {
    const path = this.pathFor(bucket, key);
    try {
      await this.assertNoSymlinks(dirname(path), key);
    } catch {
      return null;
    }
    const entry = join(this.root, '.trash', randomUUID());
    await mkdir(entry, { mode: DIR_MODE });
    const ref: TrashRef = { bucket, key };
    await writeFile(join(entry, 'ref.json'), JSON.stringify(ref), {
      mode: FILE_MODE,
    });
    try {
      await rename(path, join(entry, 'file'));
      return entry;
    } catch (error) {
      await rm(entry, { recursive: true, force: true });
      if (isFsError(error, 'ENOENT', 'ENOTDIR')) return null;
      throw error;
    }
  }

  /** Çöpteki dosyayı yerine geri koyar (yerinde yeni bir dosya yoksa). */
  async restore(entry: string): Promise<void> {
    const ref = JSON.parse(
      await readFile(join(entry, 'ref.json'), 'utf8'),
    ) as TrashRef;
    const path = this.pathFor(ref.bucket, ref.key);
    try {
      await stat(path);
      // Yerinde başka bir dosya var: onun üzerine yazılmaz.
    } catch {
      await this.ensureDir(dirname(path), ref.key);
      await this.assertNoSymlinks(dirname(path), ref.key);
      await rename(join(entry, 'file'), path);
    }
    await rm(entry, { recursive: true, force: true });
  }

  async purge(entry: string): Promise<void> {
    await rm(entry, { recursive: true, force: true });
  }

  /** Nesnenin dosyasını siler (geri alma için); yoksa sessiz. */
  async remove(bucket: string, key: string): Promise<void> {
    const path = this.pathFor(bucket, key);
    await this.assertNoSymlinks(dirname(path), key);
    try {
      await unlink(path);
    } catch (error) {
      if (!isFsError(error, 'ENOENT')) throw error;
    }
  }

  async discardTemp(tmpPath: string): Promise<void> {
    try {
      await unlink(tmpPath);
    } catch (error) {
      if (!isFsError(error, 'ENOENT')) throw error;
    }
  }

  /**
   * Yarım kalanların temizliği (açılışta). Yalnızca `olderThanMs`'den eski
   * girdilere dokunur: Coolify'ın kesintisiz dağıtımında eski süreç hâlâ bir
   * yükleme/silme yapıyor olabilir.
   *   - `.tmp` dosyaları: commit olmamış yükleme → silinir.
   *   - `.trash` girdileri: satır hâlâ varsa silme geri alınmış demektir →
   *     dosya yerine konur; satır yoksa commit olmuştur → silinir.
   */
  async sweep(
    rowExists: (bucket: string, key: string) => Promise<boolean>,
    olderThanMs: number,
    now = Date.now(),
  ): Promise<SweepResult> {
    const result: SweepResult = {
      tmpRemoved: 0,
      trashPurged: 0,
      trashRestored: 0,
    };
    const isOld = async (path: string) =>
      now - (await stat(path)).mtimeMs >= olderThanMs;

    const tmpDir = join(this.root, '.tmp');
    for (const name of await readdir(tmpDir)) {
      const path = join(tmpDir, name);
      if (await isOld(path)) {
        await rm(path, { recursive: true, force: true });
        result.tmpRemoved++;
      }
    }

    const trashDir = join(this.root, '.trash');
    for (const name of await readdir(trashDir)) {
      const entry = join(trashDir, name);
      if (!(await isOld(entry))) continue;
      let ref: TrashRef | undefined;
      try {
        ref = JSON.parse(
          await readFile(join(entry, 'ref.json'), 'utf8'),
        ) as TrashRef;
      } catch {
        ref = undefined;
      }
      if (
        ref &&
        isValidBucketId(ref.bucket) &&
        isValidObjectKey(ref.key) &&
        (await rowExists(ref.bucket, ref.key))
      ) {
        await this.restore(entry);
        result.trashRestored++;
      } else {
        await this.purge(entry);
        result.trashPurged++;
      }
    }
    return result;
  }

  /**
   * Klasörü kökten başlayarak parça parça açar. `mkdir -p` sembolik bağı
   * izleyip kök dışında klasör açardı; burada var olan her parça `lstat`'le
   * bakılır ve gerçek bir klasör olmalı (bağ ya da dosya → geçersiz ad).
   */
  private async ensureDir(dir: string, key: string): Promise<void> {
    const relative = dir.slice(this.root.length + 1).split(sep);
    let current = this.root;
    for (const part of relative) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (!info.isDirectory()) throw StorageError.invalidKey(key);
      } catch (error) {
        if (!isFsError(error, 'ENOENT')) throw error;
        try {
          await mkdir(current, { mode: DIR_MODE });
        } catch (mkdirError) {
          // Eşzamanlı bir yükleme aynı klasörü açmış olabilir.
          if (!isFsError(mkdirError, 'EEXIST')) throw mkdirError;
          const info = await lstat(current);
          if (!info.isDirectory()) throw StorageError.invalidKey(key);
        }
      }
    }
  }

  /** Klasörün gerçek yolu sözlük yoluyla aynı mı (arada sembolik bağ yok). */
  private async assertNoSymlinks(dir: string, key: string): Promise<void> {
    const real = await realpath(dir);
    if (real !== dir) throw StorageError.invalidKey(key);
  }
}

function isFsError(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    codes.includes(String(error.code))
  );
}
