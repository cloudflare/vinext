import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The prerender production server renders filesystem paths for the build, so,
// like Next.js static generation, it must not run middleware: middleware only
// decides at request time which URL serves a page. The App handler reads that
// from the execution context; the Pages pipeline gets no middleware callback.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createAppBuild(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-server-prerender-mw-app-"));
  roots.push(root);
  const serverDir = path.join(root, "dist", "server");
  fs.mkdirSync(path.join(root, "dist", "client"), { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, "index.js"),
    [
      "export default async function handler(request, ctx) {",
      "  return new Response(String(ctx.isBuildPrerender));",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function createPagesBuild(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-server-prerender-mw-pages-"));
  roots.push(root);
  const serverDir = path.join(root, "dist", "server");
  fs.mkdirSync(path.join(root, "dist", "client"), { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, "entry.js"),
    [
      "export const vinextConfig = {};",
      "export async function renderPage() {",
      "  return new Response('page', { headers: { 'content-type': 'text/html' } });",
      "}",
      "export async function handleApiRoute() { return new Response('api'); }",
      "export async function runMiddleware() {",
      "  return { continue: false, redirectUrl: '/about', pathnameEligible: true };",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

async function fetchFromServer(root: string, purpose?: "prerender") {
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server, port } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(root, "dist"),
    noCompression: true,
    purpose,
    silent: true,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/page`, { redirect: "manual" });
    return { body: await response.text(), response };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("prod server for prerendering", () => {
  it("marks App requests as build prerender renders only when started for prerendering", async () => {
    expect((await fetchFromServer(createAppBuild(), "prerender")).body).toBe("true");
    expect((await fetchFromServer(createAppBuild())).body).toBe("undefined");
  });

  it("renders Pages without middleware only when started for prerendering", async () => {
    const prerender = await fetchFromServer(createPagesBuild(), "prerender");
    expect(prerender.response.status).toBe(200);
    expect(prerender.body).toBe("page");

    const live = await fetchFromServer(createPagesBuild());
    expect(live.response.status).toBe(307);
    expect(live.response.headers.get("location")).toBe("/about");
  });
});
