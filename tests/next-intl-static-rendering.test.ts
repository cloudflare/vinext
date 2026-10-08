/**
 * next-intl static rendering in a production build.
 *
 * Regression test for https://github.com/cloudflare/vinext/issues/3671: a
 * layout sets next-intl's request locale through a React cache() store and a
 * server component below it reads the store. vinext's pre-render probe runs
 * the layout outside React's render, so the store is empty there and the
 * component falls back to headers(). The probe's dynamic usage must not make
 * the page dynamic: `next build` prerenders it, and so must vinext.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { PrerenderRouteResult } from "../packages/vinext/src/build/prerender.js";
import { buildAppFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures", "ecosystem", "next-intl");
const RSC_HEADERS = { Accept: "text/x-component", RSC: "1" };

describe("next-intl static rendering (production)", () => {
  let buildDir: string;
  let prerenderDir: string;
  let routes: PrerenderRouteResult[];
  let server: Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    const rscBundlePath = await buildAppFixture(FIXTURE_DIR);
    buildDir = path.dirname(path.dirname(rscBundlePath));
    prerenderDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-next-intl-prerender-"));

    const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    const previousNextPhase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-server";
    try {
      ({ routes } = await prerenderApp({
        mode: "default",
        rscBundlePath,
        routes: await appRouter(path.join(FIXTURE_DIR, "app")),
        outDir: prerenderDir,
        config: await resolveNextConfig({}),
      }));
    } finally {
      if (previousNextPhase === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = previousNextPhase;
    }

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({ port: 0, outDir: buildDir, noCompression: true }));
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("production server did not expose a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    for (const dir of [buildDir, prerenderDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prerenders every locale of a page whose layout sets the request locale", () => {
    const outcomes = routes
      .filter((result) => result.route === "/ssg/:locale/about")
      .map((result) =>
        result.status === "rendered"
          ? (result.path ?? result.route)
          : `${result.status}: ${"reason" in result ? result.reason : ""}`,
      );
    expect(outcomes.sort((a, b) => a.localeCompare(b))).toEqual(["/ssg/de/about", "/ssg/en/about"]);
  });

  it("serves the page from the ISR cache with the layout's locale", async () => {
    const first = await fetch(`${baseUrl}/ssg/de/about`);
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain('<html lang="de"');
    expect(html).toMatch(/data-testid="nav"[^>]*>Startseite</);
    expect(html).toMatch(/data-testid="about-title"[^>]*>Über</);

    const second = await fetch(`${baseUrl}/ssg/de/about`);
    expect(second.headers.get("x-vinext-cache")).toBe("HIT");
    expect(second.headers.get("cache-control")).toBe("s-maxage=31536000, stale-while-revalidate");
  });

  it("serves the RSC payload from the ISR cache", async () => {
    const first = await fetch(`${baseUrl}/ssg/en/about.rsc`, { headers: RSC_HEADERS });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("About");

    const second = await fetch(`${baseUrl}/ssg/en/about.rsc`, { headers: RSC_HEADERS });
    expect(second.headers.get("x-vinext-cache")).toBe("HIT");
    expect(second.headers.get("cache-control")).toBe("s-maxage=31536000, stale-while-revalidate");
  });
});
