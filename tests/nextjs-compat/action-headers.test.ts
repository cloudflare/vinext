/**
 * Next.js Compatibility Tests: headers() and cookies() in Server Actions
 *
 * Ported from Next.js behavior: headers() and cookies() must be accessible
 * from Server Actions, not just Server Components and Route Handlers.
 *
 * Related Next.js tests:
 * - test/e2e/app-dir/actions/app/headers/page.tsx
 * - test/unit/headers.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "../helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a specific action ID from a page's HTML by matching the export name
 * encoded in the hidden input's `name` attribute.
 *
 * React serialises server-action references as hidden inputs whose `name`
 * attribute encodes the action ID directly:
 *
 *   <input type="hidden" name="$ACTION_ID_/app/path/to/page.tsx#$$hoist_0_formGetHeader"/>
 *
 * The action ID (sent as the `x-rsc-action` header) is everything after
 * the `$ACTION_ID_` prefix.
 *
 * @param html       - page HTML
 * @param exportHint - substring to match within the action ID (e.g. "formGetHeader")
 */
function extractActionId(html: string, exportHint: string): string | undefined {
  const re = /name="\$ACTION_ID_([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].includes(exportHint)) return m[1];
  }
  return undefined;
}

/**
 * Invoke a server action by POSTing to the given path.
 *
 * @param baseUrl      - dev-server base URL
 * @param path         - page path (used as the POST target)
 * @param actionId     - the raw action ID from the page HTML or known module path
 * @param args         - arguments to pass to the action (JSON-serialisable array)
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
    // React uses JSON-encoded args; for simple primitives the body is a JSON
    // array like `["arg1","arg2"]`.
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
 *
 * We parse the entire first `0:` line as JSON rather than using a greedy
 * regex that could over-match across `}` characters.
 */
function extractReturnValue(text: string): unknown {
  const match = text.match(/^0:(.+)$/m);
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

describe("Next.js compat: headers() and cookies() in Server Actions", () => {
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
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/action-headers");
    expect(res.status).toBe(200);
    expect(html).toContain("Action Headers Test");
  });

  it("action-headers page exposes form action IDs for both actions", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/action-headers");
    expect(extractActionId(html, "formGetHeader")).toBeDefined();
    expect(extractActionId(html, "formGetCookie")).toBeDefined();
  });

  // ── headers() inside a server action ────────────────────────────────────
  // Next.js behaviour: headers() MUST resolve inside a server action (phase="action").

  it("headers() resolves in a server action (does not throw)", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/action-headers");
    const actionId = extractActionId(html, "formGetHeader");
    expect(actionId).toBeDefined();

    const { res, text } = await invokeAction(
      baseUrl,
      "/nextjs-compat/action-headers",
      actionId!,
      [],
      { "x-test-header": "hello-from-test" },
    );

    expect(text).not.toContain("can only be called from a Server Component");
    if (res.status === 500) {
      expect(text).not.toContain("headers() can only be called");
    }
  });

  it("cookies() resolves in a server action (does not throw)", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/action-headers");
    const actionId = extractActionId(html, "formGetCookie");
    expect(actionId).toBeDefined();

    const { res, text } = await invokeAction(
      baseUrl,
      "/nextjs-compat/action-headers",
      actionId!,
      [],
      { Cookie: "test-cookie=cookie-value" },
    );

    expect(text).not.toContain("can only be called from a Server Component");
    if (res.status === 500) {
      expect(text).not.toContain("cookies() can only be called");
    }
  });

  // ── Named server action exports return correct values ────────────────────
  // Use direct module#export action IDs so we can assert the actual returned
  // value — not just the absence of an error.

  it("getHeaderFromAction returns the request header value", async () => {
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
  // Existing tests in app-routes.test.ts and request-apis.test.ts cover each
  // API individually. This test specifically guards against regressions when
  // both are called within the *same* handler invocation.

  it("headers() and cookies() both work in the same route handler invocation", async () => {
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
});
