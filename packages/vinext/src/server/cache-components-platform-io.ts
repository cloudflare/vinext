import { isInsideAnyCacheScope, markDynamicUsage } from "vinext/shims/headers";
import {
  isPlatformIoTrackingActive,
  runWithPlatformIoTracking,
} from "vinext/shims/platform-io-tracking";

type NodeCrypto = typeof import("node:crypto");

const INSTALL_KEY = Symbol.for("vinext.cacheComponents.platformIo.install");
const CORE_INSTALLED_KEY = Symbol.for("vinext.cacheComponents.platformIo.coreInstalled");
const globalState = globalThis as typeof globalThis & Record<PropertyKey, unknown>;

function trackSynchronousPlatformIo(): void {
  if (!isPlatformIoTrackingActive() || isInsideAnyCacheScope()) return;
  markDynamicUsage();
}

function installDateTracking(): void {
  const OriginalDate = Date;
  const descriptors = Object.getOwnPropertyDescriptors(OriginalDate);
  const originalNow = OriginalDate.now;
  descriptors.now.value = function now() {
    trackSynchronousPlatformIo();
    return Reflect.apply(originalNow, OriginalDate, []);
  };

  const TrackedDate = Object.defineProperties(function Date(this: unknown, ...args: unknown[]) {
    if (new.target === undefined) {
      trackSynchronousPlatformIo();
      return Reflect.apply(OriginalDate, undefined, args);
    }
    if (args.length === 0) trackSynchronousPlatformIo();
    return Reflect.construct(OriginalDate, args, new.target);
  }, descriptors) as typeof Date;
  Object.defineProperty(OriginalDate.prototype, "constructor", { value: TrackedDate });
  globalThis.Date = TrackedDate;
}

function installMathTracking(): void {
  const originalRandom = Math.random;
  Math.random = function random() {
    trackSynchronousPlatformIo();
    return Reflect.apply(originalRandom, Math, []);
  };
}

function installWebCryptoTracking(): void {
  const webCrypto = globalThis.crypto;
  if (!webCrypto) return;

  const originalGetRandomValues = webCrypto.getRandomValues.bind(webCrypto);
  webCrypto.getRandomValues = function getRandomValues<T extends ArrayBufferView | null>(
    array: T,
  ): T {
    trackSynchronousPlatformIo();
    return Reflect.apply(originalGetRandomValues, undefined, [array]) as T;
  };

  const originalRandomUuid = webCrypto.randomUUID?.bind(webCrypto);
  if (originalRandomUuid) {
    webCrypto.randomUUID =
      function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
        trackSynchronousPlatformIo();
        return originalRandomUuid() as `${string}-${string}-${string}-${string}-${string}`;
      };
  }
}

function installCoreTracking(): void {
  if (globalState[CORE_INSTALLED_KEY] === true) return;
  globalState[CORE_INSTALLED_KEY] = true;

  try {
    installDateTracking();
  } catch {
    console.error(
      "[vinext] Failed to track Date access for Cache Components; routes using current time may be classified as static.",
    );
  }
  try {
    installMathTracking();
  } catch {
    console.error(
      "[vinext] Failed to track Math.random() for Cache Components; routes using randomness may be classified as static.",
    );
  }
  try {
    installWebCryptoTracking();
  } catch {
    console.error(
      "[vinext] Failed to track Web Crypto for Cache Components; routes using randomness may be classified as static.",
    );
  }
}

function wrapNodeCryptoFunction(
  nodeCrypto: NodeCrypto,
  name: keyof NodeCrypto,
  shouldTrack: (args: unknown[]) => boolean = () => true,
): void {
  const original = nodeCrypto[name];
  if (typeof original !== "function") return;
  Reflect.set(nodeCrypto, name, function (this: unknown, ...args: unknown[]) {
    if (shouldTrack(args)) trackSynchronousPlatformIo();
    return Reflect.apply(original, this, args);
  });
}

function installNodeCryptoTracking(): void {
  try {
    // This must not suspend: generated entries load this prelude before user
    // modules, but ESM may evaluate sibling dependencies while a top-level
    // await is pending. `process.getBuiltinModule()` lets Node-compatible
    // runtimes patch the CommonJS builtin synchronously, then publish the
    // wrappers to already-linked ESM named exports before user code runs.
    const nodeCrypto = process.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined;
    if (!nodeCrypto) return;

    wrapNodeCryptoFunction(nodeCrypto, "randomUUID");
    wrapNodeCryptoFunction(nodeCrypto, "randomBytes", (args) => typeof args[1] !== "function");
    wrapNodeCryptoFunction(nodeCrypto, "randomFillSync");
    wrapNodeCryptoFunction(nodeCrypto, "randomInt", (args) => typeof args[2] !== "function");
    wrapNodeCryptoFunction(nodeCrypto, "generatePrimeSync");
    wrapNodeCryptoFunction(nodeCrypto, "generateKeyPairSync");
    wrapNodeCryptoFunction(nodeCrypto, "generateKeySync");
    const nodeModule = process.getBuiltinModule?.("node:module") as
      | typeof import("node:module")
      | undefined;
    nodeModule?.syncBuiltinESMExports?.();
  } catch {
    // Edge runtimes need only Web Crypto. Node-compatible runtimes that expose
    // mutable builtin exports take the same path as Next.js above.
  }
}

/** Install transparent global wrappers once per isolate/process. */
export function installCacheComponentsPlatformIoTracking(): Promise<void> {
  installCoreTracking();
  const existing = globalState[INSTALL_KEY];
  if (existing instanceof Promise) return existing as Promise<void>;

  installNodeCryptoTracking();
  const installing = Promise.resolve();
  globalState[INSTALL_KEY] = installing;
  return installing;
}

/** Track only Cache Components prospective/final/prerender execution. */
export async function runWithCacheComponentsPlatformIoTracking<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  await installCacheComponentsPlatformIoTracking();
  return runWithPlatformIoTracking(fn);
}
