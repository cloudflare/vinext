import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadOrGenerateServerActionsEncryptionKey } from "../packages/vinext/src/build/server-actions-encryption-key.js";

// Ported from Next.js: packages/next/src/server/app-render/encryption-utils-server.ts
// (loadOrGenerateKey). Next covers the observable result in
// test/production/app-dir/server-action-period-hash/; these pin each cache rule.
const DAY = 1000 * 60 * 60 * 24;

describe("loadOrGenerateServerActionsEncryptionKey", () => {
  let root: string;
  const configPath = () => path.join(root, ".vinext", "cache", ".rscinfo");
  const readConfig = () => JSON.parse(fs.readFileSync(configPath(), "utf8"));
  const load = (
    options: Partial<Parameters<typeof loadOrGenerateServerActionsEncryptionKey>[0]> = {},
  ) =>
    loadOrGenerateServerActionsEncryptionKey({
      root,
      isBuild: true,
      providedKey: undefined,
      hasPersistentStorage: true,
      now: 1_000_000,
      ...options,
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-encryption-key-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("generates a 256-bit key, caches it for 14 days, and reuses it", () => {
    const key = load();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(readConfig()).toEqual({
      "encryption.key": key,
      "encryption.expire_at": 1_000_000 + 14 * DAY,
    });
    expect(load({ now: 1_000_000 + 13 * DAY })).toBe(key);
  });

  it("rotates an expired key for builds but keeps it in dev", () => {
    const key = load();
    const expired = 1_000_000 + 15 * DAY;
    expect(load({ isBuild: false, now: expired })).toBe(key);
    const rotated = load({ now: expired });
    expect(rotated).not.toBe(key);
    expect(readConfig()["encryption.key"]).toBe(rotated);
  });

  it("prefers a provided key over a different cached key, and caches it", () => {
    const generated = load();
    expect(load({ providedKey: "provided" })).toBe("provided");
    expect(readConfig()["encryption.key"]).toBe("provided");
    // Next keeps using the cached key once the variable is unset again.
    expect(load()).toBe("provided");
    expect(generated).not.toBe("provided");
  });

  it("regenerates when the cache file is broken", () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), "{not json");
    const key = load();
    expect(readConfig()["encryption.key"]).toBe(key);

    fs.writeFileSync(configPath(), JSON.stringify({ "encryption.key": key }));
    expect(load()).not.toBe(key);
  });

  it("generates a fresh key without caching when storage is likely ephemeral", () => {
    const first = load({ hasPersistentStorage: false });
    expect(load({ hasPersistentStorage: false })).not.toBe(first);
    expect(load({ hasPersistentStorage: false, providedKey: "provided" })).toBe("provided");
    expect(fs.existsSync(configPath())).toBe(false);
  });
});
