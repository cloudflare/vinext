import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { APIRequestContext, Page, Request } from "@playwright/test";
import { expect } from "@playwright/test";

export function isAppRouterRscRequestForPath(request: Request, pathname: string): boolean {
  const url = new URL(request.url());
  return (
    url.pathname === pathname && url.searchParams.has("_rsc") && request.headers()["rsc"] === "1"
  );
}

export function isAppRouterServerActionRequestForPath(request: Request, pathname: string): boolean {
  const url = new URL(request.url());
  return (
    request.method() === "POST" &&
    url.pathname === pathname &&
    request.headers()["next-action"] !== undefined
  );
}

/**
 * Wait for Pages Router hydration to complete.
 * Checks for window.__VINEXT_ROOT__.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__VINEXT_ROOT__));
}

/**
 * Wait for App Router (RSC) hydration to complete.
 * Checks for window.__VINEXT_RSC_ROOT__.
 *
 * Uses expect().toPass() for better error messages on timeout.
 * 10 second timeout matches Next.js hydration expectations.
 */
export async function waitForAppRouterHydration(page: Page): Promise<void> {
  await expect(async () => {
    const ready = await page.evaluate(async () => {
      const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
      const hasNavigate =
        typeof runtime === "object" &&
        runtime !== null &&
        "functions" in runtime &&
        typeof runtime.functions === "object" &&
        runtime.functions !== null &&
        "navigate" in runtime.functions &&
        typeof runtime.functions.navigate === "function";
      const hydrated =
        Boolean(window.__VINEXT_RSC_ROOT__) &&
        hasNavigate &&
        typeof window.__VINEXT_HYDRATED_AT === "number";

      if (!hydrated) {
        return false;
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return true;
    });
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

/**
 * Hide both Vite's HMR error overlay and vinext's dev error overlay so their
 * modal backdrops don't intercept page clicks during tests that intentionally
 * trigger an error and then need to interact with the error.tsx fallback
 * (Try Again, navigate away, etc.).
 *
 * Best-effort — silently no-ops if the page isn't ready yet.
 */
export async function disableDevErrorOverlay(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content: `
        vite-error-overlay{display:none !important;pointer-events:none !important;}
        #__vinext_dev_error_overlay_root{display:none !important;pointer-events:none !important;}
      `,
    })
    .catch(() => {
      // best effort
    });
}

/**
 * Drive the `/proxy-external-host-capture` rewrite in the pages-basic and
 * app-basic fixtures (`http://:proxyHost.invalid/host-capture`, `proxyHost`
 * from `?host=`). A decoded capture carrying `#`, `/`, `?` or `@` must not
 * move the proxy off its `.invalid` host to a listener the request names.
 */
export async function expectHostCaptureCannotRetargetProxy(
  request: APIRequestContext,
  base = "",
): Promise<void> {
  const hits: string[] = [];
  const listener = createServer((req, res) => {
    hits.push(`${req.url} cookie=${req.headers.cookie ?? ""}`);
    res.end("attacker listener");
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = listener.address() as AddressInfo;
    const proxy = (host: string) =>
      request.get(`${base}/proxy-external-host-capture?host=${encodeURIComponent(host)}`, {
        headers: { cookie: "session=victim-secret", authorization: "Bearer victim-token" },
      });

    // An ordinary host label is still proxied; `tenant.invalid` never resolves.
    expect((await proxy("tenant")).status()).toBe(502);

    for (const host of [`127.0.0.1:${port}/attacker#`, `@127.0.0.1:${port}/attacker?`]) {
      const response = await proxy(host);
      expect(await response.text()).not.toContain("attacker listener");
      expect(response.status()).toBe(500);
    }
    expect(hits).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

/** GET `path` with a raw Host header, which fetch() cannot set. */
export function getWithHost(
  baseURL: string,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ body: string; headers: IncomingHttpHeaders; status: number }> {
  const { hostname, port } = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { headers: { ...headers, host }, host: hostname, path, port },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Start a listener standing in for the external host a middleware rewrite
 * proxies to. Resolves with its `host:port` and the paths it received.
 */
export async function startRewriteUpstream(): Promise<{
  close: () => Promise<void>;
  host: string;
  hits: string[];
}> {
  const hits: string[] = [];
  const listener = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.end("external upstream");
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
    host: `127.0.0.1:${port}`,
    hits,
  };
}
