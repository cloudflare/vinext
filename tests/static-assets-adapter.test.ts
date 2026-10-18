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
  appIsrFallbackShellKey,
  pagesIsrCacheKey,
  isrGet,
} from "../packages/vinext/src/server/isr-cache.js";
import { getCdnCacheAdapter, setCdnCacheAdapter } from "../packages/vinext/src/shims/cdn-cache.js";
import { staticAssetsAdapter } from "../packages/cloudflare/src/cache/static-assets-adapter.js";
import createStaticAssetsCacheAdapter, {
  StaticAssetsCacheAdapter,
} from "../packages/cloudflare/src/cache/static-assets-adapter.runtime.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

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

  // As in Next.js, a page's special error that escaped the shell is packaged
  // with its status on both entries, and a redirect with its location.
  it.each([
    { status: 404, headers: undefined },
    { status: 307, headers: { location: "/target" } },
  ])(
    "packages a prerendered $status special error on both entries",
    async ({ status, headers }) => {
      const root = createRoot();
      write(
        root,
        "dist/server/vinext-prerender.json",
        JSON.stringify({
          buildId: "build-a",
          routes: [
            {
              route: "/special-error",
              status: "rendered",
              revalidate: 60,
              router: "app",
              responseStatus: status,
              ...(headers ? { headers } : {}),
            },
          ],
        }),
      );
      write(
        root,
        "dist/server/prerendered-routes/special-error.html",
        headers ? "" : "<h1>404</h1>",
      );
      write(root, "dist/server/prerendered-routes/special-error.rsc", "rsc payload with digest");

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

      for (const kind of ["html", "rsc"] as const) {
        const cached = await adapter.get(appIsrCacheKey("/special-error", kind, "build-a"));
        expect(cached?.value).toMatchObject({ kind: "APP_PAGE", status, headers });
      }
    },
  );

  it("packages a PPR fallback shell apart from the page of its literal path", async () => {
    const root = createRoot();
    write(
      root,
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/:lang/:slug",
            status: "rendered",
            revalidate: 60,
            router: "app",
            path: "/en/[slug]",
            fallback: true,
          },
        ],
      }),
    );
    write(root, "dist/server/prerendered-routes/en/[slug].html", "<h1>shell</h1>");
    write(root, "dist/server/prerendered-routes/en/[slug].rsc", "shell payload");

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

    // A request for `/en/%5Bslug%5D` decodes to the shell's own pathname.
    for (const kind of ["html", "rsc"] as const) {
      const shell = await adapter.get(appIsrFallbackShellKey("/en/[slug]", kind, "build-a"));
      expect(shell?.value).toMatchObject({ kind: "APP_PAGE" });
      await expect(adapter.get(appIsrCacheKey("/en/[slug]", kind, "build-a"))).resolves.toBeNull();
    }
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

  it("retries a cache index fetch that failed", async () => {
    const indexResponses: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error("network")),
      async () => new Response(null, { status: 503 }),
      async () => Response.json({}),
    ];
    const fetch = vi.fn(async (input: string) => {
      expect(new URL(input).pathname).toBe("/_vinext/static-cache/index.json");
      return indexResponses.shift()!();
    });
    const adapter = new StaticAssetsCacheAdapter({ fetch });
    await expect(adapter.get("missing")).rejects.toThrow("network");
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.get("missing")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shares a pending cache index fetch kept alive by the starting request", async () => {
    let releaseIndex!: (response: Response) => void;
    const fetch = vi.fn(
      (_input: string) => new Promise<Response>((resolve) => (releaseIndex = resolve)),
    );
    const adapter = new StaticAssetsCacheAdapter({ fetch });
    const firstRequest = { waitUntil: vi.fn() };
    const laterRequest = { waitUntil: vi.fn() };
    const first = runWithExecutionContext(firstRequest, () => adapter["loadIndex"]());
    const later = runWithExecutionContext(laterRequest, () => adapter["loadIndex"]());
    expect(fetch).toHaveBeenCalledOnce();
    expect(firstRequest.waitUntil).toHaveBeenCalledOnce();
    expect(laterRequest.waitUntil).not.toHaveBeenCalled();
    releaseIndex(Response.json({ entry: {} }));
    expect(await first).toEqual({ entry: {} });
    expect(await later).toEqual({ entry: {} });
  });

  it("retries after a shared cache index fetch fails", async () => {
    const fetch = vi
      .fn<(input: string) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(Response.json({}));
    const adapter = new StaticAssetsCacheAdapter({ fetch });
    const request = { waitUntil: vi.fn() };
    const first = runWithExecutionContext(request, () => adapter["loadIndex"]());
    const later = runWithExecutionContext(request, () => adapter["loadIndex"]());
    await expect(first).rejects.toThrow("network");
    await expect(later).rejects.toThrow("network");
    await expect(request.waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(await runWithExecutionContext(request, () => adapter["loadIndex"]())).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not share a pending cache index fetch started outside a request", async () => {
    let indexFetchStarted!: () => void;
    const started = new Promise<void>((resolve) => (indexFetchStarted = resolve));
    const fetch = vi.fn((_input: string) => {
      if (fetch.mock.calls.length > 1) return Promise.resolve(Response.json({}));
      indexFetchStarted();
      return new Promise<Response>(() => {});
    });
    const adapter = new StaticAssetsCacheAdapter({ fetch });
    void adapter.get("cancelled");
    await started;
    expect(await adapter.get("missing")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("remembers that the build packaged no cache index", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const adapter = new StaticAssetsCacheAdapter({ fetch });
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.get("missing")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats an unavailable cache index as a miss when releasing its body fails", async () => {
    const failingBody = (status: number) =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("cancel failed");
          },
        }),
        { status },
      );
    const fetch = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValueOnce(failingBody(503))
      .mockResolvedValueOnce(failingBody(404));
    const adapter = new StaticAssetsCacheAdapter({ fetch });
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.get("missing")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails clearly when the configured Assets binding is missing", () => {
    expect(() => createStaticAssetsCacheAdapter({ env: {} })).toThrow(/`ASSETS`/);
    expect(() =>
      createStaticAssetsCacheAdapter({ env: { ASSETS: {} }, options: { binding: "STATIC" } }),
    ).toThrow(/`STATIC`/);
  });
});
