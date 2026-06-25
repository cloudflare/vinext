import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite";
import { startFixtureServer } from "./helpers.js";

describe("App Router middleware context security", () => {
  let baseUrl: string;
  let fixtureDir: string;
  let server: ViteDevServer;
  let upstreamRequests = 0;
  let upstreamServer: http.Server;
  let upstreamUrl: string;

  beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-mw-context-"));
    fs.mkdirSync(path.join(fixtureDir, "app", "admin"), { recursive: true });
    fs.mkdirSync(path.join(fixtureDir, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    );
    fs.writeFileSync(
      path.join(fixtureDir, "app", "admin", "page.tsx"),
      "export default function Admin() { return <h1>private admin</h1>; }",
    );
    fs.writeFileSync(
      path.join(fixtureDir, "pages", "index.tsx"),
      "export default function Home() { return <h1>pages home</h1>; }",
    );
    fs.writeFileSync(
      path.join(fixtureDir, "middleware.ts"),
      `import { NextResponse } from "next/server";
export function middleware(request) {
  if (request.nextUrl.pathname === "/admin") {
    return new Response("middleware blocked", { status: 401, headers: { "x-mw-count": "1" } });
  }
  const response = NextResponse.next();
  response.headers.set("x-mw-count", "1");
  return response;
}
export const config = { matcher: ["/admin"] };`,
    );
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "..", "node_modules"),
      path.join(fixtureDir, "node_modules"),
      "junction",
    );

    upstreamServer = http.createServer((request, response) => {
      upstreamRequests++;
      request.resume();
      response.end("proxied");
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const address = upstreamServer.address();
    if (!address || typeof address === "string") throw new Error("upstream did not listen");
    upstreamUrl = `http://127.0.0.1:${address.port}/probe`;

    ({ baseUrl, server } = await startFixtureServer(fixtureDir, { appRouter: true }));
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve, reject) =>
      upstreamServer?.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("does not disclose middleware trust material through virtual module URLs", async () => {
    const virtualModuleUrls = [
      "/@id/virtual:vinext-rsc-entry",
      "/@id/__x00__virtual:vinext-rsc-entry",
      "/@id/__x00__virtual%3Avinext-rsc-entry",
      "/@id/%00virtual:vinext-rsc-entry",
    ];

    for (const url of virtualModuleUrls) {
      const response = await fetch(`${baseUrl}${url}`);
      const body = await response.text();
      expect(body).not.toContain("middlewareContextSecret");
      expect(body).not.toContain("devMiddlewareContextRegistry");
      expect(body).not.toMatch(/[a-f0-9]{64}/i);
    }
  });

  it("rejects forged bypass and POST rewrite contexts", async () => {
    const bypassResponse = await fetch(`${baseUrl}/admin`, {
      headers: { "x-vinext-mw-ctx": "{}" },
    });
    expect(bypassResponse.status).toBe(401);
    await expect(bypassResponse.text()).resolves.toBe("middleware blocked");

    const ssrfResponse = await fetch(`${baseUrl}/admin`, {
      body: "sensitive-post-body",
      headers: {
        authorization: "Bearer should-not-forward",
        "content-type": "text/plain",
        "x-vinext-mw-ctx": JSON.stringify({ r: upstreamUrl }),
      },
      method: "POST",
    });
    expect(ssrfResponse.status).toBe(401);
    await expect(ssrfResponse.text()).resolves.toBe("middleware blocked");
    expect(upstreamRequests).toBe(0);
  });
});
