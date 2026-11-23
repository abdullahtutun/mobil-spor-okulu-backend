import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { TEST_JWT_SECRET } from './app';
import { TEST_API_PASSWORD, type TestDatabase } from './database';

/**
 * Supabase'in kullandığı PostgREST. S07'nin okuma fonksiyonları bugün
 * uygulamaların PostgREST'ten aldığı JSON'u aynen vermeli; bunu sınamanın en
 * doğrudan yolu aynı veritabanına bağlı gerçek bir PostgREST'e uygulamanın
 * sorgusunu sormak (test/read-functions.e2e-spec.ts).
 *
 * Supabase'teki gibi kurulur: `api_authenticator` (bizim authenticator
 * rolümüz) ile bağlanır, isteğin JWT'sindeki rolüne geçer, anon rolü `anon`,
 * ek arama yolu `public, extensions`.
 */
export const POSTGREST_IMAGE = 'postgrest/postgrest:v12.2.12';

export interface TestPostgrest {
  container: StartedTestContainer;
  /** `http://host:port` */
  url: string;
  stop(): Promise<void>;
}

export async function startPostgrest(db: TestDatabase): Promise<TestPostgrest> {
  // İki konteyner aynı Docker ağında; PostgREST veritabanına iç adresle bağlanır.
  const network = db.container.getNetworkNames()[0];
  const host = db.container.getIpAddress(network);
  const container = await new GenericContainer(POSTGREST_IMAGE)
    .withEnvironment({
      PGRST_DB_URI: `postgres://api_authenticator:${TEST_API_PASSWORD}@${host}:5432/postgres`,
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_DB_EXTRA_SEARCH_PATH: 'public, extensions',
      PGRST_JWT_SECRET: TEST_JWT_SECRET,
      PGRST_DB_CHANNEL_ENABLED: 'false',
    })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forLogMessage(/Schema cache loaded/))
    .start();
  return {
    container,
    url: `http://${container.getHost()}:${container.getMappedPort(3000)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
