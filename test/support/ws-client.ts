import { WebSocket } from 'ws';

export type ServerMsg = Record<string, unknown> & { type: string };

/**
 * Testlerin realtime istemcisi: gelen mesajları sıraya koyar, `next` ile
 * bekler. "Gelmedi" iddiası zamanlamaya bağlanmaz: aynı kanala sonradan bir
 * nişan (sentinel) olayı gönderilir ve ilk gelenin o olduğu gösterilir
 * (`expectNextEvent`). Olaylar bağlantı başına sırayla işlenir.
 */
export class TestWs {
  readonly messages: ServerMsg[] = [];
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: (() => void)[] = [];
  private cursor = 0;

  constructor(url: string, options: { origin?: string } = {}) {
    this.ws = new WebSocket(url, {
      headers: options.origin ? { Origin: options.origin } : {},
    });
    // Reddedilen el sıkışması 'error' olarak gelir ("Unexpected server
    // response: 404"); sonraki hatalar da yutulur (test kapanışı).
    this.ws.on('error', () => undefined);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
    this.ws.on('message', (data: Buffer) => {
      this.messages.push(JSON.parse(data.toString()) as ServerMsg);
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((w) => w());
    });
    this.ws.on('close', () => {
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((w) => w());
    });
    // `opened` reddedildiyse yakalanmamış hata olmasın.
    this.opened.catch(() => undefined);
  }

  send(message: unknown): void {
    this.ws.send(
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }

  /** Okunmamış ilk mesaj (sırayla). */
  async next(timeoutMs = 5_000): Promise<ServerMsg> {
    const deadline = Date.now() + timeoutMs;
    while (this.cursor >= this.messages.length) {
      if (this.ws.readyState === WebSocket.CLOSED) {
        throw new Error('bağlantı kapandı, mesaj gelmedi');
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('mesaj zaman aşımı');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.messages[this.cursor++];
  }

  async auth(token: string): Promise<ServerMsg> {
    this.send({ type: 'auth', token });
    const msg = await this.next();
    if (msg.type !== 'ready')
      throw new Error(`ready beklenirdi: ${JSON.stringify(msg)}`);
    return msg;
  }

  async subscribe(channel: string): Promise<void> {
    this.send({ type: 'subscribe', channel });
    const msg = await this.next();
    if (msg.type !== 'subscribed') {
      throw new Error(`subscribed beklenirdi: ${JSON.stringify(msg)}`);
    }
  }

  /** Okunmamış mesaj kalmadı mı. */
  get pending(): number {
    return this.messages.length - this.cursor;
  }

  /** Kapatır ve kapanışı bekler (sunucu da bağlantıyı bıraksın). */
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws.close();
    await this.closed;
  }
}
