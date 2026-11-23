import { generateKeyPairSync, createVerify } from 'node:crypto';
import { HttpFcmTransport, parseServiceAccount } from './fcm.transport';
import { buildMessage } from './push-content';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ACCOUNT = {
  project_id: 'test-projesi',
  client_email: 'push@test-projesi.iam.gserviceaccount.com',
  private_key: privateKey,
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Response[]): { calls: Call[]; fn: typeof fetch } {
  const calls: Call[] = [];
  const fn = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('beklenmeyen istek');
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls, fn };
}

const tokenResponse = () =>
  new Response(
    JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }),
    {
      status: 200,
    },
  );

const message = buildMessage(
  {
    id: 'n1',
    type: 'payment_overdue',
    params: { athlete_id: 'a1' },
    tokens: [],
  },
  { token: 'cihaz-token', locale: 'tr', platform: 'android', app: 'parent' },
);

describe('parseServiceAccount', () => {
  it('boş: kapalı, hata yok', () => {
    expect(parseServiceAccount('')).toEqual({ account: null, error: null });
  });
  it('bozuk JSON ya da eksik alan: kapalı + hata', () => {
    expect(parseServiceAccount('{').error).toMatch(/JSON/);
    expect(parseServiceAccount('{"project_id":"x"}').error).toMatch(
      /private_key/,
    );
  });
  it('geçerli', () => {
    expect(
      parseServiceAccount(JSON.stringify(ACCOUNT)).account?.project_id,
    ).toBe('test-projesi');
  });
});

describe('HttpFcmTransport', () => {
  it('servis hesabıyla imzalı JWT → erişim token’ı → messages:send', async () => {
    const { calls, fn } = fakeFetch([
      tokenResponse(),
      new Response('{}', { status: 200 }),
    ]);
    const transport = new HttpFcmTransport(ACCOUNT, fn);
    await transport.prepare();
    expect(await transport.send(message)).toEqual({ ok: true });

    const tokenCall = calls[0];
    expect(tokenCall.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(tokenCall.init.body as string);
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    const [h, c, s] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({
      iss: ACCOUNT.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s, 'base64url'));
    expect(valid).toBe(true);

    const sendCall = calls[1];
    expect(sendCall.url).toBe(
      'https://fcm.googleapis.com/v1/projects/test-projesi/messages:send',
    );
    expect(
      (sendCall.init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer ya29.test');
    expect(JSON.parse(sendCall.init.body as string)).toEqual({ message });
  });

  it('erişim token’ı süresi dolana kadar yeniden kullanılır', async () => {
    let now = 1_000_000_000_000;
    const { calls, fn } = fakeFetch([
      tokenResponse(),
      new Response('{}'),
      new Response('{}'),
      tokenResponse(),
      new Response('{}'),
    ]);
    const transport = new HttpFcmTransport(ACCOUNT, fn, () => now);
    await transport.send(message);
    now += 30 * 60_000;
    await transport.send(message);
    // Süre bitimine bir dakikadan az: yenilenir.
    now += 29.5 * 60_000;
    await transport.send(message);
    expect(calls.map((c) => c.url.includes('oauth2'))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it('FCM reddi: durum + ham gövde (isDeadToken için)', async () => {
    const body = '{"error":{"status":"NOT_FOUND"}}';
    const { fn } = fakeFetch([
      tokenResponse(),
      new Response(body, { status: 404 }),
    ]);
    const transport = new HttpFcmTransport(ACCOUNT, fn);
    expect(await transport.send(message)).toEqual({
      ok: false,
      status: 404,
      body,
    });
  });

  it('Google token reddi hata olur, gövdesi mesaja girmez', async () => {
    const { fn } = fakeFetch([new Response('gizli ayrıntı', { status: 400 })]);
    const transport = new HttpFcmTransport(ACCOUNT, fn);
    await expect(transport.prepare()).rejects.toThrow(/HTTP 400$/);
  });

  it('hesap yoksa yapılandırılmamış', () => {
    expect(new HttpFcmTransport(null).configured).toBe(false);
  });
});
