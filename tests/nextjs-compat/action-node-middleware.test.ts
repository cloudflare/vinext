/**
 * Next.js Compatibility Tests: server actions under a node-runtime middleware.
 *
 * Ported from Next.js: test/e2e/app-dir/actions/app-action-node-middleware.test.ts
 * and app-action-size-limit-invalid-node-middleware.test.ts, which re-run the
 * regular server-action suites with `middleware.js` swapped for a node-runtime
 * middleware (`middleware-node.js`) that matches every path and reads the
 * request body on POST.
 *
 * Issue: cloudflare/vinext#1480 — "Server actions: request tracker never
 * intercepts action POST when node-runtime middleware is configured". When a
 * middleware that matches the action path reads the request body and then
 * falls through (`NextResponse.next()`), the server-action POST must still be
 * dispatched to the action handler and able to read its own body.
 *
 * The app-basic fixture's `middleware.ts` declares `config.runtime = "nodejs"`,
 * matches `/nextjs-compat/action-node-mw`, and consumes the request body on POST
 * before returning `NextResponse.next()`, mirroring `middleware-node.js`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "../helpers.js";

const ACTION_PATH = "/nextjs-compat/action-node-mw";
// Stable module-path action id for `echoAction` (mirrors the ids used in
// action-headers.test.ts). The page also renders a bound `<form action>` that
// references the same action, ensuring it is registered.
const ECHO_ACTION_ID = "/app/nextjs-compat/action-node-mw/actions.ts#echoAction";

describe("Next.js compat: server action under node-runtime middleware", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
    await fetch(`${baseUrl}${ACTION_PATH}`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders the page even though middleware matches and reads its POST body", async () => {
    const { res, html } = await fetchHtml(baseUrl, ACTION_PATH);
    expect(res.status).toBe(200);
    expect(html).toContain("Action Node Middleware Test");
    // The bound form action references the echo action id.
    expect(html).toContain("action-node-mw/actions.ts#echoAction");
  });

  it("dispatches the action POST after the node middleware consumed the body", async () => {
    const res = await fetch(`${baseUrl}${ACTION_PATH}.rsc`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "x-rsc-action": ECHO_ACTION_ID,
      },
      // `echoAction(value: string)` → encode a single string arg.
      body: JSON.stringify(["world"]),
    });
    const text = await res.text();

    // The action must run: a 404 here is the bug (action-not-found because the
    // POST was never intercepted / its body was unavailable after the node
    // middleware read it).
    expect(res.status).toBe(200);
    expect(res.headers.get("x-nextjs-action-not-found")).toBeNull();
    expect(text).not.toContain("Server action not found");
    // The action returns `echo:world`; a successful dispatch encodes it in the
    // RSC payload's returnValue.
    expect(text).toContain("echo:world");
  });
});
