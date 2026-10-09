/**
 * Ported from Next.js: packages/next/src/server/app-render/encryption-utils-server.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/encryption-utils-server.ts
 *
 * Next salts server-reference IDs with this key, so keeping it stable keeps
 * client chunk names stable across rebuilds of identical source. Next caches
 * a generated key under `<distDir>/cache` for builds and `<distDir>/dev/cache`
 * for dev; vinext uses `<root>/.vinext/cache` and `<root>/.vinext/dev/cache`
 * because `dist/` is wiped by every build.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "pathslash";

const CONFIG_FILE = ".rscinfo";
const ENCRYPTION_KEY = "encryption.key";
const ENCRYPTION_EXPIRE_AT = "encryption.expire_at";
const EXPIRATION = 1000 * 60 * 60 * 24 * 14; // 14 days

// Vite's default `server.fs.deny` (`_serverConfigDefaults` in
// vite/src/node/server/index.ts). A configured list replaces these defaults
// instead of extending them, so they are restated when none is configured.
const VITE_DEFAULT_FS_DENY = [
  ".env",
  ".env.*",
  "*.{crt,pem,key,p12,pfx,cer,der}",
  ".npmrc",
  ".yarnrc.yml",
  "**/.git/**",
];
const KEY_CACHE_FS_DENY = `**/.vinext/**/${CONFIG_FILE}`;

type LoadEncryptionKeyOptions = {
  root: string;
  isBuild: boolean;
  /** Defaults to `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. */
  providedKey?: string;
  now?: number;
  /** Defaults to Docker detection; Docker filesystems are likely ephemeral. */
  hasPersistentStorage?: boolean;
};

let isDockerResult: boolean | undefined;

// Mirrors next/dist/compiled/is-docker, which Next uses to skip the cache.
function isDocker(): boolean {
  if (isDockerResult === undefined) {
    let hasDockerEnv = false;
    try {
      fs.statSync("/.dockerenv");
      hasDockerEnv = true;
    } catch {}
    let hasDockerCGroup = false;
    if (!hasDockerEnv) {
      try {
        hasDockerCGroup = fs.readFileSync("/proc/self/cgroup", "utf8").includes("docker");
      } catch {}
    }
    isDockerResult = hasDockerEnv || hasDockerCGroup;
  }
  return isDockerResult;
}

function readCachedKey(
  configPath: string,
  isBuild: boolean,
  providedKey: string | undefined,
  now: number,
): string | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const config: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof config !== "object" || config === null) return undefined;
    const cachedKey = (config as Record<string, unknown>)[ENCRYPTION_KEY];
    const expireAt = (config as Record<string, unknown>)[ENCRYPTION_EXPIRE_AT];
    if (typeof cachedKey !== "string" || typeof expireAt !== "number") return undefined;
    // Builds rotate an expired key; dev keeps it so a running server and its
    // build-time key keep matching.
    if (isBuild && expireAt < now) return undefined;
    // A provided key that differs from the cache wins over it.
    if (cachedKey && providedKey && cachedKey !== providedKey) return undefined;
    return cachedKey;
  } catch {
    // Broken config file: generate a new key and overwrite it.
    return undefined;
  }
}

/**
 * Return NEXT_SERVER_ACTIONS_ENCRYPTION_KEY when set, otherwise a generated
 * key that is cached in `.vinext/cache` for 14 days.
 */
export function loadOrGenerateServerActionsEncryptionKey(
  options: LoadEncryptionKeyOptions,
): string {
  const providedKey =
    "providedKey" in options ? options.providedKey : process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
  const generateKey = () => providedKey || randomBytes(32).toString("base64");
  if (!(options.hasPersistentStorage ?? !isDocker())) return generateKey();

  const now = options.now ?? Date.now();
  // Next resolves dev's distDir to `<distDir>/dev`, so dev never reads or
  // writes the build's key.
  const cacheDir = options.isBuild
    ? path.join(options.root, ".vinext", "cache")
    : path.join(options.root, ".vinext", "dev", "cache");
  const configPath = path.join(cacheDir, CONFIG_FILE);
  const cachedKey = readCachedKey(configPath, options.isBuild, providedKey, now);
  if (cachedKey !== undefined) {
    restrictKeyCacheMode(configPath);
    return cachedKey;
  }

  const key = generateKey();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ [ENCRYPTION_KEY]: key, [ENCRYPTION_EXPIRE_AT]: now + EXPIRATION }),
    { mode: 0o600 },
  );
  // `mode` only applies when the file is created.
  restrictKeyCacheMode(configPath);
  return key;
}

function restrictKeyCacheMode(configPath: string): void {
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best effort, e.g. on file systems without POSIX modes.
  }
}

/**
 * The cached key lives inside the project root, which the dev server serves.
 * Return the `server.fs.deny` entries that keep it private, preserving Vite's
 * defaults and any configured entries. Like `.env` files, it is only exposed
 * when `server.fs.strict` is false, which turns off Vite's file restrictions.
 */
export function getServerActionsKeyCacheFsDeny(configuredDeny: string[] | undefined): string[] {
  return configuredDeny ? [KEY_CACHE_FS_DENY] : [...VITE_DEFAULT_FS_DENY, KEY_CACHE_FS_DENY];
}
