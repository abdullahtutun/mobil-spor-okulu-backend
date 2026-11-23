import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Testcontainers'ın Docker'ı bulması için ortamı hazırlar (jest-e2e
 * `setupFiles`). Ayarlanmış bir değişkene dokunmaz; yalnızca boşlukları
 * doldurur.
 *
 * colima: soket `/var/run/docker.sock`'ta değil, `~/.colima/<profil>/`
 * altında. Testcontainers `docker context`'i okumadığı için `DOCKER_HOST`
 * verilmezse Docker'ı bulamaz. Ryuk (artık konteynerleri temizleyen
 * yardımcı) soketi VM'in içinden bağlar; orada yol `/var/run/docker.sock`
 * olduğu için `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` gerekir.
 */
export function prepareDockerEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.DOCKER_HOST) {
    const profile = env.COLIMA_PROFILE ?? 'default';
    const colimaSocket = join(homedir(), '.colima', profile, 'docker.sock');
    if (existsSync(colimaSocket)) {
      env.DOCKER_HOST = `unix://${colimaSocket}`;
    }
  }
  if (
    env.DOCKER_HOST?.includes('/.colima/') &&
    !env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE
  ) {
    env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = '/var/run/docker.sock';
  }
  if (!env.DOCKER_CONFIG && missingCredentialHelper(env)) {
    env.DOCKER_CONFIG = emptyDockerConfigDir();
  }
}

/**
 * Docker Desktop kaldırılınca `~/.docker/config.json`'da
 * `"credsStore": "desktop"` kalır ama `docker-credential-desktop` artık
 * yoktur; Testcontainers her imaj işleminde bu yardımcıyı çağırıp
 * `spawn docker-credential-desktop ENOENT` ile düşer. Yardımcı PATH'te
 * bulunamıyorsa boş bir Docker yapılandırması kullanılır (herkese açık
 * imajlar için kimlik bilgisi gerekmez).
 */
function missingCredentialHelper(env: NodeJS.ProcessEnv): boolean {
  const configPath = join(homedir(), '.docker', 'config.json');
  if (!existsSync(configPath)) return false;
  let credsStore: unknown;
  try {
    credsStore = (
      JSON.parse(readFileSync(configPath, 'utf8')) as {
        credsStore?: unknown;
      }
    ).credsStore;
  } catch {
    return false;
  }
  if (typeof credsStore !== 'string' || credsStore === '') return false;
  const helper = `docker-credential-${credsStore}`;
  // existsSync sembolik bağı izler; kopuk bağ "yok" sayılır.
  return !(env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir !== '' && existsSync(join(dir, helper)));
}

function emptyDockerConfigDir(): string {
  const dir = join(tmpdir(), 'mobil-spor-okulu-docker-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{}\n');
  return dir;
}

prepareDockerEnv();
