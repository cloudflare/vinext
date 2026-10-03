import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cacheWarmupStatusSource,
  finalizeCacheAdapterPrerenderOutput,
  hasCacheAdapterPrerenderOutput,
} from "../packages/vinext/src/cache/cache-adapters-virtual.js";
import {
  appIsrCacheKey,
  pagesIsrCacheKey,
  isrGet,
} from "../packages/vinext/src/server/isr-cache.js";
import { getCdnCacheAdapter, setCdnCacheAdapter } from "../packages/vinext/src/shims/cdn-cache.js";
import { staticAssetsAdapter } from "../packages/cloudflare/src/cache/static-assets-adapter.js";
import createStaticAssetsCacheAdapter, {
  StaticAssetsCacheAdapter,
} from "../packages/cloudflare/src/cache/static-assets-adapter.runtime.js";

describe("staticAssetsAdapter", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-static-assets-cache-"));
    roots.push(root);
    return root;
  }

  function write(root: string, relativePath: string, contents: string): void {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  it("declares a read-only prerender output and validates the binding", () => {
    const descriptor = staticAssetsAdapter({ binding: "STATIC" });
    expect(descriptor.adapter.endsWith("static-assets-adapter.runtime.js")).toBe(true);
    expect(descriptor.options).toEqual({ binding: "STATIC" });
    expect(descriptor.capabilities).toEqual({
      buildIdentity: "response-header",
      warmup: "data-cache",
    });
    expect(hasCacheAdapterPrerenderOutput({ cdn: descriptor })).toBe(true);
    expect(cacheWarmupStatusSource({ cdn: descriptor })).toBe("data-cache");
    expect(() => staticAssetsAdapter({ binding: "" })).toThrow(/non-empty string/);
  });

  it.each([false, 60] as const)(
    "serves immutable build output through Assets (revalidate: %s)",
    async (revalidate) => {
      const root = createRoot();
      const clientOutDir = path.join(root, "build/client");
      write(
        root,
        "dist/server/vinext-prerender.json",
        JSON.stringify({
          buildId: "build-a",
          routes: [
            {
              route: "/",
              status: "rendered",
              revalidate,
              router: "app",
              headers: { "x-prerendered": "yes" },
            },
          ],
        }),
      );
      write(root, "dist/server/prerendered-routes/index.html", "<h1>static</h1>");
      write(root, "dist/server/prerendered-routes/index.rsc", "rsc payload");

      const descriptor = staticAssetsAdapter();
      await finalizeCacheAdapterPrerenderOutput({ cdn: descriptor }, root, {
        clientOutDir,
      });

      const assets = {
        async fetch(input: RequestInfo | URL) {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input : input.url,
          );
          const file = path.join(clientOutDir, url.pathname.replace(/^\//, ""));
          return fs.existsSync(file)
            ? new Response(fs.readFileSync(file))
            : new Response("not found", { status: 404 });
        },
      };
      const adapter = createStaticAssetsCacheAdapter({ env: { ASSETS: assets } });
      expect(adapter).toBeInstanceOf(StaticAssetsCacheAdapter);

      const html = await adapter.get(appIsrCacheKey("/", "html", "build-a"));
      expect(html).toMatchObject({
        cacheControl: { revalidate },
        value: {
          kind: "APP_PAGE",
          html: "<h1>static</h1>",
          headers: { "x-prerendered": "yes" },
        },
      });

      const rsc = await adapter.get(appIsrCacheKey("/", "rsc", "build-a"));
      expect(rsc?.value?.kind).toBe("APP_PAGE");
      if (rsc?.value?.kind !== "APP_PAGE") throw new Error("expected APP_PAGE");
      expect(new TextDecoder().decode(rsc.value.rscData)).toBe("rsc payload");

      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      await expect(
        adapter.set(appIsrCacheKey("/", "html", "build-a"), null),
      ).resolves.toBeUndefined();
      await expect(adapter.revalidateTag("tag")).resolves.toBeUndefined();
      expect(await adapter.get(appIsrCacheKey("/", "html", "build-a"))).toEqual(html);
      await expect(adapter.get("missing")).resolves.toBeNull();
    },
  );

  it("packages a rewritten source URL under its runtime cache pathname", async () => {
    const root = createRoot();
    const cachePathname = "/about?__vinext_rewrite=%2Fen%2Fabout";
    const page = {
      route: "/:locale/about",
      path: "/en/about",
      status: "rendered",
      revalidate: false,
      router: "app",
    };
    write(
      root,
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [page, { ...page, rewrite: { source: "/about", cachePathname } }],
      }),
    );
    write(root, "dist/server/prerendered-routes/en/about.html", "<h1>destination</h1>");
    write(root, "dist/server/prerendered-routes/en/about.rsc", "destination flight");
    write(
      root,
      "dist/server/prerendered-routes/__vinext/rewrite-sources/about.html",
      "<h1>source</h1>",
    );
    write(
      root,
      "dist/server/prerendered-routes/__vinext/rewrite-sources/about.rsc",
      "source flight",
    );

    await finalizeCacheAdapterPrerenderOutput({ cdn: staticAssetsAdapter() }, root);

    const clientOutDir = path.join(root, "dist/client");
    const adapter = createStaticAssetsCacheAdapter({
      env: {
        ASSETS: {
          async fetch(input: RequestInfo | URL) {
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input : input.url,
            );
            const file = path.join(clientOutDir, url.pathname.replace(/^\//, ""));
            return fs.existsSync(file)
              ? new Response(fs.readFileSync(file))
              : new Response("not found", { status: 404 });
          },
        },
      },
    });

    const html = async (pathname: string) => {
      const entry = await adapter.get(appIsrCacheKey(pathname, "html", "build-a"));
      return entry?.value?.kind === "APP_PAGE" ? entry.value.html : undefined;
    };
    expect(await html(cachePathname)).toBe("<h1>source</h1>");
    expect(await html("/en/about")).toBe("<h1>destination</h1>");

    const rsc = await adapter.get(appIsrCacheKey(cachePathname, "rsc", "build-a"));
    if (rsc?.value?.kind !== "APP_PAGE") throw new Error("expected APP_PAGE");
    expect(new TextDecoder().decode(rsc.value.rscData)).toBe("source flight");
  });

  it.each(
    [false, true].flatMap((trailingSlash) =>
      ["first", "café", "with space"].flatMap((slug) =>
        [undefined, "fr"].map((locale) => ({ trailingSlash, slug, locale })),
      ),
    ),
  )(
    "packages Pages HTML and the complete props envelope (trailingSlash: $trailingSlash, slug: $slug, locale: $locale)",
    async ({ trailingSlash, slug, locale }) => {
      const root = createRoot();
      const pathname = `/posts/${encodeURIComponent(slug)}`;
      const artifactPathname = `${locale ? `/${locale}` : ""}${pathname}`;
      const props = {
        pageProps: { slug, text: "</script>" },
        appValue: "preserved",
        __N_SSG: true,
      };
      const nextData = JSON.stringify({ props, gsp: true, locale }).replaceAll("<", "\\u003c");
      const html = `<html><script id="__NEXT_DATA__" type="application/json">${nextData}</script></html>`;
      write(
        root,
        "dist/server/vinext-prerender.json",
        JSON.stringify({
          buildId: "build-a",
          trailingSlash,
          routes: [
            {
              route: "/posts/:slug",
              path: artifactPathname,
              status: "rendered",
              revalidate: 1,
              router: "pages",
            },
          ],
        }),
      );
      write(
        root,
        `dist/server/prerendered-routes${artifactPathname}${trailingSlash ? "/index" : ""}.html`,
        html,
      );
      const descriptor = staticAssetsAdapter();
      await finalizeCacheAdapterPrerenderOutput({ cdn: descriptor }, root);
      const adapter = createStaticAssetsCacheAdapter({
        env: {
          ASSETS: {
            async fetch(input: string) {
              const file = path.join(root, "dist/client", new URL(input).pathname);
              return fs.existsSync(file)
                ? new Response(fs.readFileSync(file))
                : new Response(null, { status: 404 });
            },
          },
        },
      });
      const key = pagesIsrCacheKey(pathname, "build-a", locale ? `locale:${locale}` : undefined);
      const cached = await adapter.get(key);
      expect(cached).toMatchObject({
        cacheControl: { revalidate: 1 },
        value: { kind: "PAGES", html, pageData: props },
      });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await adapter.set(key, null);
      await adapter.revalidateTag("_N_T_/posts/first");
      expect(await adapter.get(key)).toEqual(cached);
      const previousAdapter = getCdnCacheAdapter();
      setCdnCacheAdapter(adapter);
      try {
        // Freshness is adapter-owned. A finite revalidate in an immutable
        // artifact must remain HIT even after its age exceeds that duration.
        expect(await isrGet(key)).toEqual({ value: cached, isStale: false });
      } finally {
        setCdnCacheAdapter(previousAdapter);
      }
      expect(await adapter.get(pagesIsrCacheKey("/posts/missing", "build-a"))).toBeNull();
    },
  );

  it.each([
    {
      name: "redirect",
      metadata: {
        responseStatus: 307,
        headers: { location: "/base/destination" },
        redirectProps: {
          pageProps: { __N_REDIRECT: "/destination", __N_REDIRECT_STATUS: 307 },
          __N_SSG: true,
          appValue: "preserved",
        },
      },
      expected: {
        kind: "REDIRECT",
        props: {
          pageProps: {
            __N_REDIRECT: "/destination",
            __N_REDIRECT_STATUS: 307,
          },
          __N_SSG: true,
          appValue: "preserved",
        },
      },
    },
    { name: "notFound", metadata: { notFound: true, responseStatus: 404 }, expected: null },
  ])("packages immutable localized Pages $name results", async ({ metadata, expected }) => {
    const root = createRoot();
    write(
      root,
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/terminal",
            path: "/fr/terminal",
            locale: "fr",
            status: "rendered",
            router: "pages",
            revalidate: false,
            ...metadata,
          },
        ],
      }),
    );
    write(root, "dist/server/prerendered-routes/fr/terminal.html", "<html>terminal result</html>");
    await finalizeCacheAdapterPrerenderOutput({ cdn: staticAssetsAdapter() }, root);
    const adapter = createStaticAssetsCacheAdapter({
      env: {
        ASSETS: {
          async fetch(input: string) {
            const file = path.join(root, "dist/client", new URL(input).pathname);
            return fs.existsSync(file)
              ? new Response(fs.readFileSync(file))
              : new Response(null, { status: 404 });
          },
        },
      },
    });
    const key = pagesIsrCacheKey("/terminal", "build-a", "locale:fr");
    const cached = await adapter.get(key);
    expect(cached).not.toBeNull();
    expect(cached?.value).toEqual(expected);
    await adapter.set(key, null);
    expect(await adapter.get(key)).toEqual(cached);
  });

  it("fails clearly when the configured Assets binding is missing", () => {
    expect(() => createStaticAssetsCacheAdapter({ env: {} })).toThrow(/`ASSETS`/);
    expect(() =>
      createStaticAssetsCacheAdapter({ env: { ASSETS: {} }, options: { binding: "STATIC" } }),
    ).toThrow(/`STATIC`/);
  });
});
