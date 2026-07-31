/**
 * Next.js Compatibility Tests: middleware runs for server action redirect targets.
 *
 * A server action that throws `redirect()` renders the target page inline and
 * returns its Flight payload with the action response, instead of making the
 * client re-request the target. Middleware only ran for the action's own path,
 * so the target's middleware — commonly the app's authorization boundary — has
 * to be run before that render.
 *
 * In Next.js the client re-requests the target through the full pipeline, so a
 * middleware-blocked target is never rendered from the action request. Here the
 * fixture's middleware blocks `/admin` with a 403; the action response must fall
 * back to a header-only redirect the client re-requests, carrying no payload.
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

const ACTION_PATH = "/nextjs-compat/action-redirect-middleware";
const ACTIONS = "/app/nextjs-compat/action-redirect-middleware/actions.ts";
const ACTION_ID = `${ACTIONS}#redirectToBlockedPath`;
const ENCODED_ACTION_ID = `${ACTIONS}#redirectToEncodedBlockedPath`;

async function postAction(
  baseUrl: string,
  actionId: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ res: Response; text: string }> {
  const res = await fetch(`${baseUrl}${ACTION_PATH}.rsc`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-rsc-action": actionId, ...extraHeaders },
    body: JSON.stringify([]),
  });
  return { res, text: await res.text() };
}

describe("Next.js compat: server action redirect targets run middleware", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
    await fetch(`${baseUrl}${ACTION_PATH}`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("blocks a direct request to the redirect target", async () => {
    const res = await fetch(`${baseUrl}/admin`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Protected admin content");
  });

  it("does not return the blocked target's payload from the action response", async () => {
    const { res, text } = await postAction(baseUrl, ACTION_ID);

    expect(res.headers.get("x-action-redirect")).toBe("/admin");
    expect(text).not.toContain("Protected admin content");
    // A header-only redirect the client re-requests through the full pipeline,
    // where middleware gets to block it.
    expect(res.headers.get("content-type")).toBeNull();
    expect(text).toBe("");
  });

  // The dev-only forwarded-middleware-context header carries the *action* path's
  // middleware result. Replayed for the target it would skip middleware
  // execution entirely, so it must not survive onto the target's request.
  it("ignores a forwarded middleware context when evaluating the target", async () => {
    const { res, text } = await postAction(baseUrl, ACTION_ID, {
      "x-vinext-mw-ctx": JSON.stringify({ h: [["x-mw-ran", "true"]] }),
    });

    expect(res.headers.get("x-action-redirect")).toBe("/admin");
    expect(text).not.toContain("Protected admin content");
    expect(text).toBe("");
  });

  // Route matching that decodes resolves /adm%69n to the /admin page, but
  // middleware and a real navigation both see /adm%69n. Rendering the decoded
  // route inline would serve a page neither of them reached.
  it("does not render a percent-encoded alias of the blocked target", async () => {
    const { res, text } = await postAction(baseUrl, ENCODED_ACTION_ID);

    expect(res.headers.get("x-action-redirect")).toBe("/adm%69n");
    expect(res.headers.get("content-type")).toContain("text/x-component");
    expect(text).not.toContain("Protected admin content");
    expect(text).toContain("404 - Page Not Found");
  });
});
