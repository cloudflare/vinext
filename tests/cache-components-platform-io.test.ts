import {
  generateKeyPairSync,
  generateKeySync,
  generatePrimeSync,
  randomBytes,
  randomFillSync,
  randomInt,
  randomUUID,
} from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  installCacheComponentsPlatformIoTracking,
  runWithCacheComponentsPlatformIoTracking,
} from "../packages/vinext/src/server/cache-components-platform-io.js";
import { consumeDynamicUsage } from "../packages/vinext/src/shims/headers.js";

const USE_CACHE_ALS_KEY = Symbol.for("vinext.cacheRuntime.contextAls");

function consumeTrackedDynamicUsage(): boolean {
  return consumeDynamicUsage();
}

afterEach(() => {
  consumeTrackedDynamicUsage();
  Reflect.deleteProperty(globalThis, USE_CACHE_ALS_KEY);
});

// Ported from Next.js Cache Components platform-I/O coverage:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.date.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.random.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.web-crypto.test.ts
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/cache-components/app/node-crypto
describe("Cache Components synchronous platform I/O tracking", () => {
  it("tracks current time and randomness only inside an active render", async () => {
    await installCacheComponentsPlatformIoTracking();

    Date.now();
    new Date();
    Date();
    Math.random();
    crypto.getRandomValues(new Uint8Array(1));
    crypto.randomUUID();
    expect(consumeTrackedDynamicUsage()).toBe(false);

    await runWithCacheComponentsPlatformIoTracking(() => {
      Date.now();
      new Date();
      Date();
      Math.random();
      crypto.getRandomValues(new Uint8Array(1));
      crypto.randomUUID();
    });
    expect(consumeTrackedDynamicUsage()).toBe(true);
  });

  it("does not treat explicit Date inputs as current-time I/O", async () => {
    await runWithCacheComponentsPlatformIoTracking(() => {
      new Date(0);
      new Date("2020-01-01T00:00:00.000Z");
    });

    expect(consumeTrackedDynamicUsage()).toBe(false);
  });

  it("tracks the synchronous Node crypto APIs wrapped by Next.js", async () => {
    const calls: Array<() => unknown> = [
      () => randomUUID(),
      () => randomBytes(1),
      () => randomFillSync(new Uint8Array(1)),
      () => randomInt(0, 2),
      () => generatePrimeSync(8),
      () => generateKeyPairSync("ed25519"),
      () => generateKeySync("aes", { length: 128 }),
    ];

    for (const call of calls) {
      await runWithCacheComponentsPlatformIoTracking(call);
      expect(consumeTrackedDynamicUsage()).toBe(true);
    }
  });

  it("does not track asynchronous Node crypto calls", async () => {
    await runWithCacheComponentsPlatformIoTracking(
      () =>
        new Promise<void>((resolve, reject) => {
          randomBytes(1, (error) => (error ? reject(error) : resolve()));
        }),
    );

    expect(consumeTrackedDynamicUsage()).toBe(false);
  });

  it("allows platform I/O inside public and private use-cache scopes", async () => {
    for (const variant of ["public", "private"]) {
      Reflect.set(globalThis, USE_CACHE_ALS_KEY, {
        getStore: () => ({ variant }),
      });
      await runWithCacheComponentsPlatformIoTracking(() => {
        Date.now();
        Math.random();
        crypto.randomUUID();
        randomUUID();
      });
      expect(consumeTrackedDynamicUsage()).toBe(false);
    }
  });
});
