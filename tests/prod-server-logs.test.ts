import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createPagesBuild(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-server-logs-"));
  const distDir = path.join(root, "dist");
  const clientDir = path.join(distDir, "client");
  const serverDir = path.join(distDir, "server");

  fs.mkdirSync(clientDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, "entry.js"),
    [
      "export const vinextConfig = {};",
      "export async function renderPage() { return new Response('ok', { headers: { 'content-type': 'text/html' } }); }",
      "export async function handleApiRoute() { return new Response('api'); }",
      "export async function runMiddleware() { return null; }",
      "",
    ].join("\n"),
  );

  return root;
}

function createAppBuild(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-server-app-logs-"));
  const distDir = path.join(root, "dist");
  const clientDir = path.join(distDir, "client");
  const serverDir = path.join(distDir, "server");

  fs.mkdirSync(clientDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, "index.js"),
    [
      "export default async function handler() {",
      "  return new Response('ok', { headers: { 'content-type': 'text/html' } });",
      "}",
      "",
    ].join("\n"),
  );

  return root;
}

describe("startProdServer logging", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the generic production server log by default", async () => {
    const root = createPagesBuild();
    roots.push(root);
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => {
      messages.push(message);
    });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server, port } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(messages).toEqual([`[vinext] Production server running at http://127.0.0.1:${port}`]);
  });

  it("logs a prerender-specific production server URL when requested", async () => {
    const root = createPagesBuild();
    roots.push(root);
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => {
      messages.push(message);
    });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server, port } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
      purpose: "prerender",
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(messages).toEqual([
      `[vinext] Production server for prerendering running at http://127.0.0.1:${port}`,
    ]);
  });

  it("uses the prerender-specific startup log for App Router production servers", async () => {
    const root = createAppBuild();
    roots.push(root);
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => {
      messages.push(message);
    });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server, port } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
      purpose: "prerender",
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(messages).toEqual([
      `[vinext] Production server for prerendering running at http://127.0.0.1:${port}`,
    ]);
  });
});
