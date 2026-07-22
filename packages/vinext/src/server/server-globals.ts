/**
 * Server runtime global setup shared by vinext's generated server entries.
 *
 * This module intentionally runs its installer at import time. Generated entry
 * modules import user pages and layouts as static dependencies, so any global
 * correction that must happen before user module evaluation has to live in a
 * side-effect dependency. A runtime function call from the generated entry
 * body would run after static user imports have already evaluated.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type BrowserGlobalName = "window" | "document";

function clearBrowserGlobal(name: BrowserGlobalName): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  if (!descriptor && typeof Reflect.get(globalThis, name) === "undefined") return;

  if (!descriptor) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: undefined,
      writable: true,
    });
  } else if (descriptor.configurable) {
    Reflect.deleteProperty(globalThis, name);
  } else {
    Reflect.set(globalThis, name, undefined);
  }

  if (typeof Reflect.get(globalThis, name) !== "undefined") {
    throw new Error(
      `[vinext] Server runtime exposes a non-removable \`${name}\` global. ` +
        "This breaks Next.js SSR semantics where browser globals must be absent.",
    );
  }
}

export function installServerGlobals(): void {
  clearBrowserGlobal("window");
  clearBrowserGlobal("document");

  // Next.js's edge sandbox exposes AsyncLocalStorage as a global. Cloudflare
  // Workers exposes it via node:async_hooks under nodejs_compat, so mirror the
  // global binding for user code written against Next.js's runtime.
  if (typeof Reflect.get(globalThis, "AsyncLocalStorage") === "undefined") {
    Object.defineProperty(globalThis, "AsyncLocalStorage", {
      configurable: true,
      value: AsyncLocalStorage,
      writable: true,
    });
  }
}

installServerGlobals();
