import { execSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown() {
  execSync('docker compose down --volumes', {
    cwd: __dirname,
    stdio: 'inherit',
  });
}
