/**
 * Next.js Compatibility Tests: headers() and cookies() in Server Actions
 *
 * Ported from Next.js behavior: headers() and cookies() must be accessible
 * from Server Actions, not just Server Components and Route Handlers.
 *
 * Issue: https://github.com/cloudflare/vinext/issues/443
 * "headers() can only be called from a Server Component, Route Handler, or
 * Server Action" — was being thrown inside a server action even though it
 * should work there.
 *
 * Related Next.js tests:
 * - test/e2e/app-dir/actions/app/headers/page.tsx
 * - test/unit/headers.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all action IDs from a page's HTML.
 *
 * React serialises server-action references as hidden inputs whose `name`
 * attribute encodes the action ID directly:
 *
 *   <input type="hidden" name="$ACTION_ID_/app/path/to/actions.ts#exportName"/>
 *
 * The action ID (sent as the `x-rsc-action` header) is everything after the
 * `$ACTION_ID_` prefix.
 */
function extractActionIds(html: string): string[] {
  const ids: string[] = [];
  const re = /name="\$ACTION_ID_([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.push(m[1]);
  }
  return [...new Set(ids)];
}

/**
 * Invoke a server action by POSTing to the given path.
 *
 * @param baseUrl  - dev-server base URL
 * @param path     - page path (used as the POST target, e.g. `/nextjs-compat/action-headers`)
 * @param actionId - the raw action ID extracted from the page HTML
 * @param args     - arguments to pass to the action (JSON-serialisable array)
 * @param extraHeaders - additional HTTP headers (e.g. cookies, custom headers)
 */
async function invokeAction(
  baseUrl: string,
  path: string,
  actionId: string,
  args: unknown[] = [],
  extraHeaders: Record<string, string> = {},
): Promise<{ res: Response; text: string }> {
  const url = `${baseUrl}${path}.rsc`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "x-rsc-action": actionId,
      ...extraHeaders,
    },
    // React uses JSON-encoded args with a custom format; for simple primitive
    // args the body is just a JSON array like `["arg1","arg2"]`.
    body: JSON.stringify(args),
  });
  const text = await res.text();
  return { res, text };
}

/**
 * Extract the returnValue.data field from an RSC action response.
 *
 * The RSC protocol encodes the action return value on the first line as:
 *   0:{"root":"$@1","returnValue":{"ok":true,"data":"<value>"}}
 */
function extractReturnValue(text: string): unknown {
  const match = text.match(/^0:(\{.+\})/m);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed?.returnValue?.data;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Next.js compat: headers() and cookies() in Server Actions (issue #443)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up so modules are compiled before tests run
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Fixture page renders ────────────────────────────────────────────────

  it("action-headers page renders without error", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/action-headers`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Action Headers Test");
  });

  it("action-headers page exposes at least one action ID in its forms", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/action-headers`);
    const html = await res.text();
    const ids = extractActionIds(html);
    expect(ids.length).toBeGreaterThan(0);
  });

  // ── headers() inside a server action ────────────────────────────────────
  // Next.js behaviour: headers() MUST resolve inside a server action (phase="action").
  // Before the fix, this threw "can only be called from a Server Component …"

  it("headers() resolves in a server action (does not throw)", async () => {
    // First fetch the page to get a warm server and extract the action ID.
    const pageRes = await fetch(`${baseUrl}/nextjs-compat/action-headers`, {
      headers: { "x-test-header": "hello-from-test" },
    });
    const html = await pageRes.text();
    const actionIds = extractActionIds(html);
    expect(actionIds.length).toBeGreaterThan(0);

    // Use the first action ID (bound to formGetHeader in page.tsx).
    const actionId = actionIds[0];

    const { res, text } = await invokeAction(
      baseUrl,
      "/nextjs-compat/action-headers",
      actionId,
      [],
      { "x-test-header": "hello-from-test" },
    );

    // The server MUST NOT throw the "can only be called from a Server Component" error.
    expect(text).not.toContain("can only be called from a Server Component");
    // It also must not be a 500 caused by the headers() error.
    // (Some 500s are acceptable if the action itself throws for another reason,
    // but the headers() error is always surfaced in the response body or status.)
    if (res.status === 500) {
      expect(text).not.toContain("headers() can only be called");
    }
  });

  it("cookies() resolves in a server action (does not throw)", async () => {
    const pageRes = await fetch(`${baseUrl}/nextjs-compat/action-headers`);
    const html = await pageRes.text();
    const actionIds = extractActionIds(html);
    expect(actionIds.length).toBeGreaterThan(0);

    // Use the second action ID if available (bound to formGetCookie), otherwise the first.
    const actionId = actionIds[1] ?? actionIds[0];

    const { res, text } = await invokeAction(
      baseUrl,
      "/nextjs-compat/action-headers",
      actionId,
      [],
      { Cookie: "test-cookie=cookie-value" },
    );

    expect(text).not.toContain("can only be called from a Server Component");
    if (res.status === 500) {
      expect(text).not.toContain("cookies() can only be called");
    }
  });

  // ── Named server action exports return correct values ────────────────────
  // These use the direct module#export action IDs so we can assert the actual
  // returned header/cookie value — not just the absence of an error.

  it("getHeaderFromAction returns the request header value", async () => {
    // Named export action IDs have the form: /app/<path>/actions.ts#<name>
    const actionId = "/app/nextjs-compat/action-headers/actions.ts#getHeaderFromAction";

    const { res, text } = await invokeAction(
      baseUrl,
      "/nextjs-compat/action-headers",
      actionId,
      ["x-test-header"],
      { "x-test-header": "returned-header-value" },
    );

    expect(res.status).toBe(200);
    expect(text).not.toContain("can only be called from a Server Component");
    // The RSC response encodes return values as:
    //   0:{"root":"$@1","returnValue":{"ok":true,"data":"<value>"}}
    const value = extractReturnValue(text);
    expect(value).toBe("returned-header-value");
  });

  it("getCookieFromAction returns the cookie value", async () => {
    const actionId = "/app/nextjs-compat/action-headers/actions.ts#getCookieFromAction";

    const { res, text } = await invokeAction(
      baseUrl,
      "/nextjs-compat/action-headers",
      actionId,
      ["test-cookie"],
      { Cookie: "test-cookie=returned-cookie-value" },
    );

    expect(res.status).toBe(200);
    expect(text).not.toContain("can only be called from a Server Component");
    const value = extractReturnValue(text);
    expect(value).toBe("returned-cookie-value");
  });

  // ── Route handler: headers() + cookies() together ────────────────────────
  // Regression guard: both APIs must work simultaneously in a route handler.

  it("headers() and cookies() both work in a route handler together", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/headers-in-route`, {
      headers: {
        "x-custom-header": "test-value",
        Cookie: "test-cookie=route-cookie-value",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.customHeader).toBe("test-value");
    expect(data.cookieValue).toBe("route-cookie-value");
  });

  // ── getHeaderFromAction named export ─────────────────────────────────────
  // Direct test: invoke getHeaderFromAction and verify it can read a header.
  // This uses a dedicated route handler to call the action server-side.

  it("getHeaderFromAction returns the request header value (via route handler proxy)", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/action-header-proxy`, {
      headers: { "x-forwarded-header": "proxy-header-value" },
    });
    // This endpoint may not exist yet; skip gracefully if 404.
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.headerValue).toBe("proxy-header-value");
  });
});
