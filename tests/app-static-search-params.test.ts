import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import vinext from "../packages/vinext/src/index.js";

const fixtureRoots: string[] = [];

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("App Router static useSearchParams", () => {
  afterAll(async () => {
    await Promise.all(fixtureRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("renders the nearest Suspense fallback into prerendered HTML", async () => {
    // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
    const workspaceRoot = path.resolve(import.meta.dirname, "..");
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-search-params-"));
    fixtureRoots.push(fixtureRoot);

    await writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ name: "vinext-search-params", private: true, type: "module" }, null, 2),
    );
    await writeFile(
      path.join(fixtureRoot, "next.config.ts"),
      `export default {
  async rewrites() {
    return [
      {
        source: "/rewritten-dynamic-search-params",
        destination: "/dynamic-search-params?value=rewritten-value",
      },
      {
        source: "/rewritten-late-no-store",
        destination: "/late-no-store?value=late-rewritten-value",
      },
      {
        source: "/rewritten-revalidate-false",
        destination: "/revalidate-false-search-params",
      },
      {
        source: "/rewritten-open-tail",
        destination: "/open-tail?value=open-tail-rewritten",
      },
    ];
  },
};`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "layout.tsx"),
      `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "search-params.tsx"),
      `"use client";
import { useSearchParams } from "next/navigation";

export default function SearchParams() {
  return <p id="value">{useSearchParams().get("value") ?? "missing"}</p>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "page.tsx"),
      `import { Suspense } from "react";
import SearchParams from "./search-params";

export default function Page() {
  return <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "force-static", "page.tsx"),
      `export const dynamic = "force-static";

import { Suspense } from "react";
import SearchParams from "../search-params";

export default function Page() {
  return <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "dynamic-search-params", "page.tsx"),
      `import { Suspense } from "react";
import SearchParams from "../search-params";

export default async function Page({ searchParams }) {
  const value = (await searchParams).value;
  return <>
    <p id="server-value">{value}</p>
    <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>
  </>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "no-store-search-params", "page.tsx"),
      `import { Suspense } from "react";
import { unstable_noStore } from "next/cache";
import SearchParams from "../search-params";

export default function Page() {
  unstable_noStore();
  return <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "late-no-store", "page.tsx"),
      `import { Suspense } from "react";
import { unstable_noStore } from "next/cache";
import SearchParams from "../search-params";

async function LateNoStore() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  unstable_noStore();
  return <SearchParams />;
}

export default function Page() {
  return <Suspense fallback={<p>late no-store suspense</p>}><LateNoStore /></Suspense>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "revalidate-false-search-params", "page.tsx"),
      `export const revalidate = false;

import { Suspense } from "react";
import SearchParams from "../search-params";

export default function Page() {
  return <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "stream-gate.ts"),
      `const gateKey = Symbol.for("vinext.test.static-search-params-stream-gate");

type Gate = { armed: boolean; promise: Promise<void>; release: () => void };

function getGate(): Gate | undefined {
  return Reflect.get(globalThis, gateKey) as Gate | undefined;
}

export function armStreamGate(): void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  Reflect.set(globalThis, gateKey, { armed: true, promise, release } satisfies Gate);
}

export function releaseStreamGate(): void {
  getGate()?.release();
}

export async function waitForStreamGate(): Promise<boolean> {
  const gate = getGate();
  if (!gate?.armed) return false;
  await gate.promise;
  gate.armed = false;
  return true;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "stream-gate", "route.ts"),
      `import { armStreamGate, releaseStreamGate } from "../stream-gate";

export async function POST(request: Request) {
  const action = new URL(request.url).searchParams.get("action");
  if (action === "arm") armStreamGate();
  if (action === "release") releaseStreamGate();
  return new Response("ok");
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "open-tail", "page.tsx"),
      `export const revalidate = false;

import { Suspense } from "react";
import { unstable_noStore } from "next/cache";
import SearchParams from "../search-params";
import { waitForStreamGate } from "../stream-gate";

async function OpenTail() {
  if (await waitForStreamGate()) unstable_noStore();
  return <SearchParams />;
}

export default function Page() {
  return <Suspense fallback={<p>open tail suspense</p>}><OpenTail /></Suspense>;
}`,
    );
    await fs.symlink(
      path.join(workspaceRoot, "node_modules"),
      path.join(fixtureRoot, "node_modules"),
    );

    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: false,
      plugins: [
        vinext({
          appDir: fixtureRoot,
          rscOutDir: path.join(fixtureRoot, "dist", "server"),
          ssrOutDir: path.join(fixtureRoot, "dist", "server", "ssr"),
          clientOutDir: path.join(fixtureRoot, "dist", "client"),
        }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    await runPrerender({
      root: fixtureRoot,
      rscBundlePath: path.join(fixtureRoot, "dist", "server", "index.js"),
      concurrency: 1,
    });

    const html = await fs.readFile(
      path.join(fixtureRoot, "dist", "server", "prerendered-routes", "index.html"),
      "utf8",
    );
    expect(html).toContain("<p>search params suspense</p>");
    expect(html).not.toContain('<p id="value">missing</p>');
    expect(html).toContain('"useLocationSearchParams":true');

    const forceStaticHtml = await fs.readFile(
      path.join(fixtureRoot, "dist", "server", "prerendered-routes", "force-static.html"),
      "utf8",
    );
    expect(forceStaticHtml).not.toContain("<p>search params suspense</p>");
    expect(forceStaticHtml).toContain('<p id="value">missing</p>');
    expect(forceStaticHtml).not.toContain('"useLocationSearchParams":true');

    // Consuming the Server Component searchParams prop makes this a dynamic
    // request render. Next.js therefore SSRs a nested client useSearchParams()
    // instead of applying prerender-only CSR bailout semantics.
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureRoot, "dist"),
      noCompression: true,
    });
    // Simulate an evicted prerender artifact so revalidate=false takes the
    // runtime cache-miss path instead of serving the startup-seeded entry.
    Reflect.deleteProperty(globalThis, Symbol.for("vinext.cacheHandler"));
    try {
      const address = server.address();
      expect(address && typeof address === "object").toBeTruthy();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(
        `http://127.0.0.1:${port}/dynamic-search-params?value=dynamic-value`,
      );
      expect(response.status).toBe(200);
      const dynamicHtml = await response.text();
      expect(dynamicHtml).toMatch(/<p id="server-value">(?:<!-- -->)?dynamic-value<\/p>/);
      expect(dynamicHtml).toMatch(/<p id="value">(?:<!-- -->)?dynamic-value<\/p>/);
      expect(dynamicHtml).not.toContain("<p>search params suspense</p>");
      expect(dynamicHtml).not.toContain("BAILOUT_TO_CLIENT_SIDE_RENDERING");
      expect(dynamicHtml).not.toContain('"useLocationSearchParams":true');

      const noStoreResponse = await fetch(
        `http://127.0.0.1:${port}/no-store-search-params?value=no-store-value`,
      );
      expect(noStoreResponse.status).toBe(200);
      const noStoreHtml = await noStoreResponse.text();
      expect(noStoreHtml).toMatch(/<p id="value">(?:<!-- -->)?no-store-value<\/p>/);
      expect(noStoreHtml).not.toContain("<p>search params suspense</p>");
      expect(noStoreHtml).not.toContain("BAILOUT_TO_CLIENT_SIDE_RENDERING");
      expect(noStoreHtml).not.toContain('"useLocationSearchParams":true');

      const rewrittenResponse = await fetch(
        `http://127.0.0.1:${port}/rewritten-dynamic-search-params`,
      );
      expect(rewrittenResponse.status).toBe(200);
      const rewrittenHtml = await rewrittenResponse.text();
      expect(rewrittenHtml).toMatch(/<p id="server-value">(?:<!-- -->)?rewritten-value<\/p>/);
      expect(rewrittenHtml).toMatch(/<p id="value">(?:<!-- -->)?rewritten-value<\/p>/);
      expect(rewrittenHtml).toContain('"searchParams":[["value","rewritten-value"]]');
      expect(rewrittenHtml).not.toContain('"useLocationSearchParams":true');
      expect(rewrittenHtml).not.toContain("BAILOUT_TO_CLIENT_SIDE_RENDERING");

      const lateNoStoreResponse = await fetch(`http://127.0.0.1:${port}/rewritten-late-no-store`);
      expect(lateNoStoreResponse.status).toBe(200);
      const lateNoStoreHtml = await lateNoStoreResponse.text();
      expect(lateNoStoreHtml).toMatch(/<p id="value">(?:<!-- -->)?late-rewritten-value<\/p>/);
      expect(lateNoStoreHtml).toContain('"searchParams":[["value","late-rewritten-value"]]');
      expect(lateNoStoreHtml).toContain("<p>late no-store suspense</p>");
      expect(lateNoStoreHtml).not.toContain('"useLocationSearchParams":true');
      expect(lateNoStoreHtml).not.toContain("BAILOUT_TO_CLIENT_SIDE_RENDERING");

      const evictedResponse = await fetch(
        `http://127.0.0.1:${port}/rewritten-revalidate-false?value=evicted-value`,
      );
      expect(evictedResponse.status).toBe(200);
      const evictedHtml = await evictedResponse.text();
      expect(evictedHtml).toContain("<p>search params suspense</p>");
      expect(evictedHtml).not.toMatch(/<p id="value">(?:<!-- -->)?evicted-value<\/p>/);
      expect(evictedHtml).toContain('"useLocationSearchParams":true');

      await fetch(`http://127.0.0.1:${port}/stream-gate?action=arm`, { method: "POST" });
      Reflect.deleteProperty(globalThis, Symbol.for("vinext.cacheHandler"));

      const openTailResponse = await Promise.race([
        fetch(`http://127.0.0.1:${port}/rewritten-open-tail?visible=location`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("open-tail response headers did not stream")), 5_000),
        ),
      ]);
      expect(openTailResponse.status).toBe(200);
      const reader = openTailResponse.body?.getReader();
      expect(reader).toBeTruthy();
      const decoder = new TextDecoder();
      let openTailHtml = "";
      while (!openTailHtml.includes("<p>open tail suspense</p>")) {
        const chunk = await Promise.race([
          reader!.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("open-tail fallback did not stream")), 5_000),
          ),
        ]);
        expect(chunk.done).toBe(false);
        openTailHtml += decoder.decode(chunk.value, { stream: true });
      }

      await fetch(`http://127.0.0.1:${port}/stream-gate?action=release`, { method: "POST" });
      for (;;) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        openTailHtml += decoder.decode(chunk.value, { stream: true });
      }
      openTailHtml += decoder.decode();
      expect(openTailHtml).toContain('["value","open-tail-rewritten"]');
      expect(openTailHtml).toContain('"searchParamsDecisionPending":true');
      expect(openTailHtml).toContain("delete b.nav.useLocationSearchParams");
      expect(openTailHtml).not.toContain('"useLocationSearchParams":true');
    } finally {
      server.close();
      Reflect.deleteProperty(globalThis, Symbol.for("vinext.cacheHandler"));
    }
  }, 60_000);
});
