import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";

import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "./helpers.js";

type BrowserGlobalName = "window" | "document";

function definePartialBrowserGlobal(name: BrowserGlobalName, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

describe("server globals", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let originalWindow: PropertyDescriptor | undefined;
  let originalDocument: PropertyDescriptor | undefined;

  beforeAll(async () => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

    definePartialBrowserGlobal("window", { getComputedStyle: undefined, history: undefined });
    definePartialBrowserGlobal("document", { documentElement: {} });

    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
  }, 60_000);

  afterAll(async () => {
    await server?.close();

    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");

    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });

  it("clears browser globals before App Router user modules evaluate in dev", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/typeof-window-ssr");

    expect(res.status).toBe(200);
    expect(html).toContain("server globals ok");
  }, 30_000);
});
