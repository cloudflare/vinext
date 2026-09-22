import { execSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  // Start Postgres + Redis via Docker Compose. `--wait` blocks until the
  // healthchecks in docker-compose.yml pass, so the app can connect immediately.
  execSync('docker compose up -d --wait', {
    cwd: __dirname,
    stdio: 'inherit',
  });
}
