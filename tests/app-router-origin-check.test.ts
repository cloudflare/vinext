import { type ViteDevServer } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

describe("App Router dev server origin check", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("allows requests with no Origin header (direct navigation)", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
  });

  it("allows same-origin requests", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: baseUrl },
    });
    expect(res.status).toBe(200);
  });

  it("blocks requests with Origin 'null' (CSRF via sandboxed context)", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "null" },
    });
    // Origin "null" must be blocked unless explicitly allowlisted (CVE: GHSA-jcc7-9wpm-mj36).
    expect(res.status).toBe(403);
  });

  it("blocks cross-origin requests", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  it("blocks cross-origin requests to internal Vite paths (/@*)", async () => {
    const res = await fetch(`${baseUrl}/@fs/etc/passwd`, {
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  it("blocks requests with Sec-Fetch-Site: cross-site and no-cors mode", async () => {
    // Node.js fetch strips Sec-Fetch-* headers (they're forbidden headers
    // in the Fetch spec). Use raw HTTP to simulate browser behavior.
    const http = await import("node:http");
    const url = new URL(baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: "/",
          method: "GET",
          headers: {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "no-cors",
          },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("blocks cross-origin requests to source files", async () => {
    const res = await fetch(`${baseUrl}/app/page.tsx`, {
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  it("blocks requests with malformed Origin header", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "not-a-url" },
    });
    expect(res.status).toBe(403);
  });
});
