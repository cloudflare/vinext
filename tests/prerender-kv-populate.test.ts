import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { buildPrerenderKVPairs } from "../packages/cloudflare/src/prerender-kv-populate.js";

let serverDir: string;

function writePrerenderFixture(
  manifest: Record<string, unknown>,
  files: Record<string, string | Buffer>,
): void {
  fs.writeFileSync(
    path.join(serverDir, "vinext-prerender.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  const prerenderDir = path.join(serverDir, "prerendered-routes");
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(prerenderDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

describe("buildPrerenderKVPairs", () => {
  beforeEach(() => {
    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-kv-"));
  });

  afterEach(() => {
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  it("builds KV entries for prerendered App Router HTML and RSC artifacts", () => {
    writePrerenderFixture(
      {
        buildId: "build-1",
        routes: [
          {
            route: "/about",
            status: "rendered",
            revalidate: 60,
            expire: 300,
            router: "app",
            headers: { link: "</font.woff2>; rel=preload; as=font" },
          },
        ],
      },
      {
        "about.html": "<html>About</html>",
        "about.rsc": "flight",
      },
    );

    const { routeCount, pairs } = buildPrerenderKVPairs(serverDir, {
      appPrefix: "site-a",
      now: 1_000,
      ttlSeconds: 123,
    });

    expect(routeCount).toBe(1);
    expect(pairs.map((pair) => pair.key)).toEqual([
      "site-a:cache:app:build-1:/about:html",
      "site-a:cache:app:build-1:/about:rsc",
    ]);
    expect(pairs.map((pair) => pair.expiration_ttl)).toEqual([123, 123]);

    const htmlEntry = JSON.parse(pairs[0].value);
    expect(htmlEntry).toMatchObject({
      value: {
        kind: "APP_PAGE",
        html: "<html>About</html>",
        headers: { link: "</font.woff2>; rel=preload; as=font" },
      },
      lastModified: 1_000,
      revalidateAt: 61_000,
      expireAt: 301_000,
      cacheControl: { revalidate: 60, expire: 300 },
    });
    expect(pairs[0].metadata).toEqual({ tags: htmlEntry.tags });
    expect(htmlEntry.tags).toContain("/about");
    expect(htmlEntry.tags).toContain("_N_T_/about/page");

    const rscEntry = JSON.parse(pairs[1].value);
    expect(rscEntry.value).toMatchObject({
      kind: "APP_PAGE",
      html: "",
      rscData: Buffer.from("flight").toString("base64"),
    });
  });

  it("omits KV expiration for static prerendered routes", () => {
    writePrerenderFixture(
      {
        buildId: "build-static",
        routes: [{ route: "/static", status: "rendered", revalidate: false, router: "app" }],
      },
      { "static.html": "<html>Static</html>" },
    );

    const { pairs } = buildPrerenderKVPairs(serverDir, { now: 2_000 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).not.toHaveProperty("expiration_ttl");

    const entry = JSON.parse(pairs[0].value);
    expect(entry.revalidateAt).toBeNull();
    expect(entry.expireAt).toBeNull();
    expect(entry.cacheControl).toBeUndefined();
  });

  it("returns no pairs when the prerender manifest or artifacts are absent", () => {
    expect(buildPrerenderKVPairs(serverDir)).toEqual({ routeCount: 0, pairs: [] });

    fs.writeFileSync(
      path.join(serverDir, "vinext-prerender.json"),
      JSON.stringify({
        buildId: "build",
        routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
      }),
    );
    expect(buildPrerenderKVPairs(serverDir)).toEqual({ routeCount: 0, pairs: [] });
  });

  it("rejects prerender artifact paths that escape the prerender directory", () => {
    writePrerenderFixture(
      {
        buildId: "build-escape",
        routes: [
          {
            route: "/escape",
            path: "/../escape",
            status: "rendered",
            revalidate: 60,
            router: "app",
          },
        ],
      },
      {},
    );
    fs.mkdirSync(path.join(serverDir, "prerendered-routes"), { recursive: true });

    expect(() => buildPrerenderKVPairs(serverDir)).toThrow(/outside/);
  });
});
