/**
 * Kaynak dosya deposu: yalnızca OKUR. Canlıda Supabase storage-api'den
 * service role anahtarıyla `GET` (indirme); başka bir HTTP yöntemi yoktur.
 */
export interface StorageSource {
  download(bucket: string, name: string): Promise<Buffer>;
}

/** Supabase storage-api: `GET /storage/v1/object/authenticated/<bucket>/<ad>`. */
export class SupabaseStorageSource implements StorageSource {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async download(bucket: string, name: string): Promise<Buffer> {
    const path = [bucket, ...name.split('/')]
      .map((s) => encodeURIComponent(s))
      .join('/');
    const url = `${this.baseUrl.replace(/\/+$/, '')}/storage/v1/object/authenticated/${path}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.serviceKey}`,
        apikey: this.serviceKey,
      },
    });
    if (!res.ok) {
      throw new Error(`${bucket}/${name} indirilemedi: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
