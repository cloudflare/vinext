import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

// Next.js applies middleware's status before the route runs
// (router-utils/resolve-routes.js); a redirect the route raises then sets its
// own 307/308 (send-response.js for route handlers), so the redirect wins.
describe("App Router: middleware status vs route redirect", { timeout: 60_000 }, () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("NextResponse.rewrite(url, { status: 404 }) + page redirect() returns 307", async () => {
    const res = await fetch(`${baseUrl}/middleware-rewrite-status-redirect`, {
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("NextResponse.next({ status: 404 }) + page permanentRedirect() returns 308", async () => {
    const res = await fetch(`${baseUrl}/middleware-status-permanent-redirect`, {
      redirect: "manual",
    });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("NextResponse.rewrite(url, { status: 404 }) + route handler redirect() returns 307", async () => {
    const res = await fetch(`${baseUrl}/middleware-rewrite-status-redirect-route`, {
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/about");
  });
});
