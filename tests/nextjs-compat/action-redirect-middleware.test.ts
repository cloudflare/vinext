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
 *
 * It also pins the action redirect response status. Ported from Next.js
 * (vercel/next.js#96310, shipped in v16.3.0):
 * test/e2e/app-dir/actions/app-action.test.ts and
 * test/e2e/app-dir/actions/app-action-progressive-enhancement.test.ts
 * https://github.com/vercel/next.js/blob/v16.3.0/test/e2e/app-dir/actions/app-action.test.ts
 * A fetch action's redirect is answered with 200 and no Location (the client
 * router navigates from `x-action-redirect`), whether or not the target's
 * Flight payload is streamed with it. Only a no-JS form submission gets a 303
 * with a Location.
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

const ACTION_PATH = "/nextjs-compat/action-redirect-middleware";
const ACTIONS = "/app/nextjs-compat/action-redirect-middleware/actions.ts";
const ACTION_ID = `${ACTIONS}#redirectToBlockedPath`;
const ENCODED_ACTION_ID = `${ACTIONS}#redirectToEncodedBlockedPath`;
const ABOUT_ACTION_ID = `${ACTIONS}#redirectToAbout`;
const PERMANENT_ABOUT_ACTION_ID = `${ACTIONS}#permanentRedirectToAbout`;
const EXTERNAL_ACTION_ID = `${ACTIONS}#redirectToExternal`;
const MIDDLEWARE_REDIRECT_ACTION_ID = `${ACTIONS}#redirectToMiddlewareRedirect`;

/** A client-router (fetch) action call, shaped like the browser action client's. */
async function postFetchAction(
  baseUrl: string,
  actionId: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ res: Response; text: string }> {
  const res = await fetch(`${baseUrl}${ACTION_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "next-action": actionId,
      rsc: "1",
      "x-rsc-action": actionId,
      ...extraHeaders,
    },
    body: JSON.stringify([]),
    redirect: "manual",
  });
  return { res, text: await res.text() };
}

/** A no-JS progressive-enhancement submission of a bound `<form action>`. */
async function postProgressiveAction(baseUrl: string, actionId: string): Promise<Response> {
  const formData = new FormData();
  formData.set(`$ACTION_ID_${actionId}`, "");
  return fetch(`${baseUrl}${ACTION_PATH}`, {
    method: "POST",
    headers: { Origin: baseUrl },
    body: formData,
    redirect: "manual",
  });
}

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

  describe("redirect response status", () => {
    it("answers a fetch action redirect with a streamed target with 200", async () => {
      const { res, text } = await postFetchAction(baseUrl, ABOUT_ACTION_ID);

      expect(res.status).toBe(200);
      expect(res.headers.get("x-action-redirect")).toBe("/about");
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/x-component");
      expect(text).toContain("About");
    });

    it("answers a fetch action permanentRedirect with 200", async () => {
      const { res } = await postFetchAction(baseUrl, PERMANENT_ABOUT_ACTION_ID);

      expect(res.status).toBe(200);
      expect(res.headers.get("x-action-redirect")).toBe("/about");
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/x-component");
    });

    it("answers a fetch action redirect followed through a middleware redirect with 200", async () => {
      const { res, text } = await postFetchAction(baseUrl, MIDDLEWARE_REDIRECT_ACTION_ID);

      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/x-component");
      expect(text).toContain("About");
    });

    it("answers a header-only fetch action redirect with 200", async () => {
      // The middleware-blocked target is not streamed; the client re-requests it.
      const { res, text } = await postFetchAction(baseUrl, ACTION_ID);

      expect(res.status).toBe(200);
      expect(res.headers.get("x-action-redirect")).toBe("/admin");
      expect(res.headers.get("location")).toBeNull();
      expect(text).toBe("");
    });

    it("answers a fetch action redirect to an external URL with 200", async () => {
      const { res, text } = await postFetchAction(baseUrl, EXTERNAL_ACTION_ID);

      expect(res.status).toBe(200);
      expect(res.headers.get("x-action-redirect")).toBe("https://example.com/destination");
      expect(res.headers.get("location")).toBeNull();
      expect(text).toBe("");
    });

    // The source path's next.config headers are merged into header-only
    // redirects up front; finalization must not apply them a second time.
    it.each([
      ["a middleware-blocked target", ACTION_ID],
      ["an external URL", EXTERNAL_ACTION_ID],
    ])(
      "applies source config headers once to a header-only redirect to %s",
      async (_label, actionId) => {
        const { res, text } = await postFetchAction(baseUrl, actionId, {
          "x-action-config-header-probe": "1",
        });

        expect(res.status).toBe(200);
        expect(text).toBe("");
        // A Flight Content-Type on the empty body would make the client decode
        // it instead of taking the header-only navigation path.
        expect(res.headers.get("content-type")).toBeNull();
        expect(
          res.headers.getSetCookie().filter((cookie) => cookie.startsWith("action-config-cookie=")),
        ).toHaveLength(1);
        expect(res.headers.get("x-action-source-only")).toBe("yes");
      },
    );

    it("answers a no-JS form action redirect with 303 and a Location", async () => {
      const res = await postProgressiveAction(baseUrl, ABOUT_ACTION_ID);

      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location") ?? "", baseUrl).pathname).toBe("/about");
      expect(res.headers.get("x-action-redirect")).toBeNull();
    });

    it("answers a no-JS form action permanentRedirect with 303 and a Location", async () => {
      const res = await postProgressiveAction(baseUrl, PERMANENT_ABOUT_ACTION_ID);

      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location") ?? "", baseUrl).pathname).toBe("/about");
    });
  });
});
