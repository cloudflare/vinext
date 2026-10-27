import { describe, expect, it, vi } from "vite-plus/test";
import {
  collectAppPageSearchParams,
  prepareAppPageHead,
  resolveActiveParallelRouteHeadInputs,
  resolveAppPageHead,
  resolveInterceptLayoutsBesidePage,
  type AppPageHeadParallelRoute,
} from "../packages/vinext/src/server/app-page-head.js";
import type { AppPageParams } from "../packages/vinext/src/server/app-page-boundary.js";
import { resolveHttpAccessFallbackMetadata } from "../packages/vinext/src/server/app-page-http-access-fallback-metadata.js";

describe("app page head resolution", () => {
  it("prepares viewport independently while generated metadata is pending", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    let releaseMetadata: (() => void) | undefined;
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });

    const prepared = prepareAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      pageModule: {
        async generateMetadata() {
          await metadataGate;
          return { title: "streamed page" };
        },
        generateViewport() {
          return { themeColor: "#123456" };
        },
      },
      params: {},
      routePath: "/streamed",
    });

    expect(prepared.hasDynamicMetadata).toBe(true);
    await expect(prepared.viewport).resolves.toMatchObject({
      themeColor: [{ color: "#123456" }],
    });

    let metadataSettled = false;
    void prepared.metadata.then(() => {
      metadataSettled = true;
    });
    await Promise.resolve();
    expect(metadataSettled).toBe(false);

    releaseMetadata?.();
    await expect(prepared.metadata).resolves.toMatchObject({ title: "streamed page" });
  });

  it("reports whether the matched route has generated metadata", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    const staticResult = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      pageModule: { metadata: { title: "static page" } },
      params: {},
      routePath: "/static",
    });

    const generatedResult = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      pageModule: {
        async generateMetadata() {
          return { title: "generated page" };
        },
      },
      params: {},
      routePath: "/generated",
    });

    expect(staticResult.hasDynamicMetadata).toBe(false);
    expect(generatedResult.hasDynamicMetadata).toBe(true);
  });

  it("collects repeated search params into a null-prototype object", () => {
    const { hasSearchParams, pageSearchParams } = collectAppPageSearchParams(
      new URLSearchParams("__proto__=safe&tag=a&tag=b"),
    );

    expect(hasSearchParams).toBe(true);
    expect(Object.getPrototypeOf(pageSearchParams)).toBe(null);
    expect(Reflect.get(pageSearchParams, "__proto__")).toBe("safe");
    expect(pageSearchParams.tag).toEqual(["a", "b"]);
  });

  it("preserves query keys that collide with Object prototype names", async () => {
    let generatedSearchParams: Record<string, unknown> | undefined;

    const page = {
      async generateMetadata(props: { searchParams?: Promise<Record<string, unknown>> }) {
        generatedSearchParams = await props.searchParams;
        return null;
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      pageModule: page,
      params: {},
      routePath: "/",
      routeSegments: [],
      searchParams: new URLSearchParams(
        "constructor=ctor&toString=stringifier&__proto__=prototype",
      ),
    });

    expect(Reflect.get(result.pageSearchParams, "constructor")).toBe("ctor");
    expect(Reflect.get(result.pageSearchParams, "toString")).toBe("stringifier");
    expect(Reflect.get(result.pageSearchParams, "__proto__")).toBe("prototype");
    expect(Reflect.get(generatedSearchParams ?? {}, "constructor")).toBe("ctor");
    expect(Reflect.get(generatedSearchParams ?? {}, "toString")).toBe("stringifier");
    expect(Reflect.get(generatedSearchParams ?? {}, "__proto__")).toBe("prototype");
  });

  it("resolves layout and page metadata with parent chaining and page-only search params", async () => {
    const layoutSearchParamsSeen: unknown[] = [];
    const layoutParamsSeen: unknown[] = [];
    const pageParentImages: unknown[] = [];

    const rootLayout = {
      metadata: {
        openGraph: {
          images: ["/root-og.png"],
        },
        title: { default: "Root", template: "%s | Root" },
      },
      viewport: {
        width: "device-width",
      },
    };
    const nestedLayout = {
      async generateMetadata(
        props: { params?: Promise<Record<string, string | string[]>>; searchParams?: unknown },
        parent: Promise<unknown>,
      ) {
        layoutSearchParamsSeen.push(props.searchParams);
        layoutParamsSeen.push(await props.params);
        const parentMetadata = await parent;
        const parentOpenGraph =
          typeof parentMetadata === "object" && parentMetadata
            ? Reflect.get(parentMetadata, "openGraph")
            : null;
        const parentImages =
          typeof parentOpenGraph === "object" && parentOpenGraph
            ? Reflect.get(parentOpenGraph, "images")
            : [];
        return {
          openGraph: {
            images: [...(Array.isArray(parentImages) ? parentImages : []), "/nested-og.png"],
          },
        };
      },
    };
    const page = {
      async generateMetadata(
        props: { searchParams?: Promise<Record<string, string | string[]>> },
        parent: Promise<unknown>,
      ) {
        const searchParams = await props.searchParams;
        const parentMetadata = await parent;
        const parentOpenGraph =
          typeof parentMetadata === "object" && parentMetadata
            ? Reflect.get(parentMetadata, "openGraph")
            : null;
        const parentImages =
          typeof parentOpenGraph === "object" && parentOpenGraph
            ? Reflect.get(parentOpenGraph, "images")
            : [];
        pageParentImages.push(...(Array.isArray(parentImages) ? parentImages : []));

        const tagValue = searchParams?.tag;
        return {
          description: `tag ${Array.isArray(tagValue) ? tagValue.join(",") : tagValue}`,
          title: "Post",
        };
      },
      viewport: {
        initialScale: 1,
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout, nestedLayout],
      layoutTreePositions: [0, 1],
      metadataRoutes: [],
      pageModule: page,
      params: { slug: "post" },
      routePath: "/blog/[slug]",
      routeSegments: ["blog", "[slug]"],
      searchParams: new URLSearchParams("tag=next&tag=vinext"),
    });

    expect(result.metadata).toEqual({
      description: "tag next,vinext",
      openGraph: {
        description: "tag next,vinext",
        images: ["/root-og.png", "/nested-og.png"],
        title: "Post | Root",
      },
      title: "Post | Root",
      twitter: {
        card: "summary_large_image",
        description: "tag next,vinext",
        images: ["/root-og.png", "/nested-og.png"],
        title: "Post | Root",
      },
    });
    expect(result.viewport).toEqual({
      colorScheme: null,
      initialScale: 1,
      themeColor: null,
      width: "device-width",
    });
    expect(result.pageSearchParams).toEqual({ tag: ["next", "vinext"] });
    expect(result.hasSearchParams).toBe(true);
    expect(layoutSearchParamsSeen).toEqual([undefined]);
    expect(layoutParamsSeen).toEqual([{}]);
    expect(pageParentImages).toEqual(["/root-og.png", "/nested-og.png"]);
  });

  it("resolves viewport descriptors with parent chaining", async () => {
    // Matches Next.js's sequential parent resolution in accumulateViewport:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
    const parentViewports: unknown[] = [];
    const rootLayout = {
      viewport: {
        themeColor: "#111111",
        viewportFit: "cover",
        width: "device-width",
      },
    };
    const nestedLayout = {
      async generateViewport(
        _props: unknown,
        parent: Promise<unknown> = Promise.resolve({ height: "default-parent" }),
      ) {
        parentViewports.push(await parent);
        return {
          initialScale: 2,
          themeColor: {
            color: "#222222",
            media: "(prefers-color-scheme: dark)",
          },
        };
      },
    };
    const page = {
      async generateViewport(...args: [unknown, Promise<unknown>]) {
        parentViewports.push(await args[1]);
        return {
          interactiveWidget: "overlays-content",
          viewportFit: undefined,
        };
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout, nestedLayout],
      layoutTreePositions: [0, 1],
      metadataRoutes: [],
      pageModule: page,
      params: {},
      routePath: "/nested",
      routeSegments: ["nested"],
    });

    expect(parentViewports).toEqual([
      {
        colorScheme: null,
        initialScale: 1,
        themeColor: [{ color: "#111111" }],
        viewportFit: "cover",
        width: "device-width",
      },
      {
        colorScheme: null,
        initialScale: 2,
        themeColor: [
          {
            color: "#222222",
            media: "(prefers-color-scheme: dark)",
          },
        ],
        viewportFit: "cover",
        width: "device-width",
      },
    ]);
    expect(result.viewport).toEqual({
      colorScheme: null,
      initialScale: 2,
      interactiveWidget: "overlays-content",
      themeColor: [
        {
          color: "#222222",
          media: "(prefers-color-scheme: dark)",
        },
      ],
      viewportFit: undefined,
      width: "device-width",
    });
  });

  it("keeps layout tree positions aligned when layout module slots are empty", async () => {
    const nestedLayoutParamsSeen: unknown[] = [];

    const rootLayout = {
      metadata: {
        title: "Root",
      },
    };
    const nestedLayout = {
      async generateMetadata(props: { params?: Promise<Record<string, string | string[]>> }) {
        nestedLayoutParamsSeen.push(await props.params);
        return {
          description: "Nested",
        };
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout, null, nestedLayout],
      layoutTreePositions: [0, 2, 1],
      metadataRoutes: [],
      params: { slug: "post" },
      routePath: "/blog/[slug]",
      routeSegments: ["blog", "[slug]"],
    });

    expect(result.metadata).toEqual({
      description: "Nested",
      title: "Root",
    });
    expect(nestedLayoutParamsSeen).toEqual([{}]);
  });

  it("passes scoped params to layout metadata and full params/searchParams to page metadata", async () => {
    // Ported from Next.js: test/e2e/app-dir/layout-params/layout-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/layout-params/layout-params.test.ts
    const layoutParamCalls: AppPageParams[] = [];
    let pageParams: AppPageParams | null = null;
    let pageSearchParams: Record<string, string | string[]> = {};

    const rootLayout = {
      async generateMetadata({ params }: { params: Promise<AppPageParams> }) {
        layoutParamCalls.push(await params);
        return { title: "root" };
      },
    };
    const categoryLayout = {
      async generateMetadata({ params }: { params: Promise<AppPageParams> }) {
        layoutParamCalls.push(await params);
        return { description: "category" };
      },
    };
    const page = {
      async generateMetadata({
        params,
        searchParams,
      }: {
        params: Promise<AppPageParams>;
        searchParams: Promise<Record<string, string | string[]>>;
      }) {
        pageParams = await params;
        pageSearchParams = await searchParams;
        return { keywords: ["page"] };
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout, categoryLayout],
      layoutTreePositions: [1, 2],
      metadataRoutes: [],
      pageModule: page,
      params: { category: "books", id: "dune" },
      routePath: "/shop/[category]/[id]",
      routeSegments: ["shop", "[category]", "[id]"],
      searchParams: new URLSearchParams("tag=a&tag=b&q=hello"),
    });

    expect(layoutParamCalls).toEqual([{}, { category: "books" }]);
    expect(pageParams).toEqual({ category: "books", id: "dune" });
    expect({ ...pageSearchParams }).toEqual({
      q: "hello",
      tag: ["a", "b"],
    });
    expect(result.hasSearchParams).toBe(true);
    expect(result.metadata).toMatchObject({
      description: "category",
      keywords: ["page"],
    });
  });

  it("passes observed searchParams to primary and parallel page viewports", async () => {
    // Ported from Next.js: test/e2e/app-dir/use-cache-search-params/
    // app/search-params-used-generate-viewport/page.tsx
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-search-params/app/search-params-used-generate-viewport/page.tsx
    const observeParamAccess = vi.fn();
    const viewportColors: string[] = [];
    const createPageModule = () => ({
      async generateViewport({
        searchParams,
      }: {
        searchParams: Promise<Record<string, string | string[]>>;
      }) {
        const query = await searchParams;
        viewportColors.push(typeof query.color === "string" ? query.color : "missing");
        return { themeColor: typeof query.color === "string" ? query.color : "black" };
      },
    });

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      pageModule: createPageModule(),
      parallelRoutes: [{ pageModule: createPageModule(), routeSegments: ["dashboard"] }],
      params: {},
      routePath: "/dashboard",
      routeSegments: ["dashboard"],
      searchParams: new URLSearchParams("color=red"),
      searchParamsObserver: { observeParamAccess },
    });

    expect(viewportColors).toEqual(["red", "red"]);
    expect(observeParamAccess).toHaveBeenCalled();
    expect(result.viewport.themeColor).toEqual([{ color: "red" }]);
  });

  it("accumulates the primary page viewport before named slots", async () => {
    // Next.js seeds the loader tree with `children` before named parallel
    // segments, then walks those branches in insertion order.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/loaders/next-app-loader/index.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
    const parentViewports: Array<{ source: string; viewport: unknown }> = [];
    const firstSlotLayout = {
      async generateViewport(_props: unknown, parent: Promise<unknown>) {
        parentViewports.push({ source: "first layout", viewport: await parent });
        return { height: 111 };
      },
    };
    const firstSlotPage = {
      async generateViewport(_props: unknown, parent: Promise<unknown>) {
        parentViewports.push({ source: "first page", viewport: await parent });
        return { maximumScale: 7, minimumScale: 0.5 };
      },
    };
    const secondSlotPage = {
      async generateViewport(_props: unknown, parent: Promise<Record<string, unknown>>) {
        const viewport = await parent;
        parentViewports.push({ source: "second page", viewport });
        return { initialScale: viewport.minimumScale === 0.5 ? 4 : 5 };
      },
    };
    const primaryPage = {
      async generateViewport(_props: unknown, parent: Promise<Record<string, unknown>>) {
        const viewport = await parent;
        parentViewports.push({ source: "primary page", viewport });
        return { maximumScale: viewport.initialScale === 4 ? 2 : 9 };
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [{ viewport: { viewportFit: "cover" } }],
      metadataRoutes: [],
      pageModule: primaryPage,
      parallelRoutes: [
        {
          layoutModules: [firstSlotLayout],
          pageModule: firstSlotPage,
          routeSegments: ["dashboard"],
        },
        {
          pageModule: secondSlotPage,
          routeSegments: ["dashboard"],
        },
      ],
      params: {},
      routePath: "/dashboard",
      routeSegments: ["dashboard"],
    });

    expect(parentViewports).toEqual([
      {
        source: "primary page",
        viewport: {
          colorScheme: null,
          initialScale: 1,
          themeColor: null,
          viewportFit: "cover",
          width: "device-width",
        },
      },
      {
        source: "first layout",
        viewport: {
          colorScheme: null,
          initialScale: 1,
          maximumScale: 9,
          themeColor: null,
          viewportFit: "cover",
          width: "device-width",
        },
      },
      {
        source: "first page",
        viewport: {
          colorScheme: null,
          height: 111,
          initialScale: 1,
          maximumScale: 9,
          themeColor: null,
          viewportFit: "cover",
          width: "device-width",
        },
      },
      {
        source: "second page",
        viewport: {
          colorScheme: null,
          height: 111,
          initialScale: 1,
          maximumScale: 7,
          minimumScale: 0.5,
          themeColor: null,
          viewportFit: "cover",
          width: "device-width",
        },
      },
    ]);
    expect(result.viewport).toMatchObject({
      height: 111,
      initialScale: 4,
      maximumScale: 7,
      minimumScale: 0.5,
      viewportFit: "cover",
    });
  });

  it("bubbles layout metadata errors", async () => {
    await expect(
      resolveAppPageHead<Record<string, unknown>>({
        layoutModules: [
          {
            generateMetadata() {
              throw new Error("layout metadata failed");
            },
          },
        ],
        metadataRoutes: [],
        params: {},
        routePath: "/",
        routeSegments: [],
      }),
    ).rejects.toThrow("layout metadata failed");
  });

  it("bubbles layout viewport errors", async () => {
    await expect(
      resolveAppPageHead<Record<string, unknown>>({
        layoutModules: [
          {
            generateViewport() {
              throw new Error("layout viewport failed");
            },
          },
        ],
        metadataRoutes: [],
        params: {},
        routePath: "/",
        routeSegments: [],
      }),
    ).rejects.toThrow("layout viewport failed");
  });

  it("includes active parallel route metadata in resolved head", async () => {
    const slotParentDescriptions: unknown[] = [];
    const rootLayout = {
      metadata: {
        description: "Root description",
        title: "Root title",
      },
    };
    const page = {
      metadata: {
        title: "Page title",
      },
    };
    const slotPage = {
      async generateMetadata(_props: unknown, parent: Promise<Record<string, unknown>>) {
        const parentMetadata = await parent;
        slotParentDescriptions.push(parentMetadata.description);
        return {
          openGraph: {
            title: "Slot OG title",
          },
        };
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: page,
      parallelRoutes: [
        {
          pageModule: slotPage,
          routeSegments: ["dashboard"],
        },
      ],
      params: {},
      routePath: "/dashboard",
      routeSegments: ["dashboard"],
    });

    expect(slotParentDescriptions).toEqual(["Root description"]);
    expect(result.metadata).toEqual({
      description: "Root description",
      openGraph: {
        description: "Root description",
        title: "Slot OG title",
      },
      title: "Page title",
      twitter: {
        card: "summary",
        description: "Root description",
        title: "Slot OG title",
      },
    });
  });

  it("includes nested active parallel route layout metadata", async () => {
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      parallelRoutes: [
        {
          layoutModules: [
            { metadata: { description: "slot root" } },
            { metadata: { title: "nested slot layout" } },
          ],
          pageModule: { metadata: { openGraph: { title: "slot page" } } },
          routeSegments: ["dashboard"],
        },
      ],
      params: {},
      routePath: "/dashboard",
      routeSegments: ["dashboard"],
    });

    expect(result.metadata).toMatchObject({
      description: "slot root",
      title: "nested slot layout",
      openGraph: { title: "slot page" },
    });
  });

  it("uses mirrored slot params for parallel route metadata", () => {
    const slotPage = {};
    expect(
      resolveActiveParallelRouteHeadInputs({
        params: { primary: "value" },
        routeSegments: ["dashboard"],
        slotParams: { sidebar: { member: "alice" } },
        slots: { sidebar: { page: slotPage, routeSegments: ["[member]"] } },
      }),
    ).toEqual([
      {
        head: {
          layoutModules: [],
          layoutParams: [],
          layoutTreePositions: [],
          pageModule: slotPage,
          params: { member: "alice" },
          routeSegments: ["[member]"],
        },
        ownerTreePosition: 0,
        slotKey: "sidebar",
      },
    ]);
  });

  it("orders nested slot head inputs like Next.js's children-first tree walk", () => {
    const outerFirst = {};
    const outerSecond = {};
    const inner = {};

    const inputs = resolveActiveParallelRouteHeadInputs({
      layoutTreePositions: [0, 2],
      params: {},
      routeSegments: ["dashboard", "settings"],
      slots: {
        outerFirst: { layoutIndex: 0, page: outerFirst },
        outerSecond: { layoutIndex: 0, page: outerSecond },
        inner: { layoutIndex: 1, page: inner },
      },
    });

    expect(inputs.map((input) => input.head.pageModule)).toEqual([inner, outerFirst, outerSecond]);
  });

  it("orders one owner's slots by name, as Turbopack's loader tree does", () => {
    const alpha = { metadata: { title: "alpha" } };
    const beta = { metadata: { title: "beta" } };

    // Discovery order (the record's key order) must not decide which slot's
    // metadata merges last.
    const inputs = resolveActiveParallelRouteHeadInputs({
      layoutTreePositions: [0],
      params: {},
      routeSegments: [],
      slots: {
        "beta@@beta": { layoutIndex: 0, name: "beta", page: beta },
        "alpha@@alpha": { layoutIndex: 0, name: "alpha", page: alpha },
      },
    });

    expect(inputs.map((input) => input.head.pageModule)).toEqual([alpha, beta]);
  });

  it("orders slot names by code point, as Turbopack's BTreeMap does", () => {
    const bmp = { metadata: { title: "bmp" } };
    const astral = { metadata: { title: "astral" } };

    // @豈 (U+F900) sorts before @𐀀 (U+10000) by UTF-8 bytes, but after it by
    // UTF-16 code units.
    const inputs = resolveActiveParallelRouteHeadInputs({
      layoutTreePositions: [0],
      params: {},
      routeSegments: [],
      slots: {
        "\u{10000}@@\u{10000}": { layoutIndex: 0, name: "\u{10000}", page: astral },
        "\u{F900}@@\u{F900}": { layoutIndex: 0, name: "\u{F900}", page: bmp },
      },
    });

    expect(inputs.map((input) => input.head.pageModule)).toEqual([bmp, astral]);
  });

  it("orders slots by their own directory, not the layout that renders them", () => {
    const alpha = { metadata: { title: "alpha" } };
    const zeta = { metadata: { title: "zeta" } };

    // app/@alpha and app/(group)/@zeta with no (group) layout: the root layout
    // renders both, but the walk finishes (group) under root's `children`
    // first. Next.js 16.2.7 (Turbopack) titles such a page "alpha".
    const inputs = resolveActiveParallelRouteHeadInputs({
      layoutTreePositions: [0],
      params: {},
      routeSegments: ["(group)"],
      slots: {
        "alpha@@alpha": { layoutIndex: 0, name: "alpha", ownerTreePosition: 0, page: alpha },
        "zeta@(group)/@zeta": { layoutIndex: 0, name: "zeta", ownerTreePosition: 1, page: zeta },
      },
    });

    expect(inputs.map((input) => input.head.pageModule)).toEqual([zeta, alpha]);
  });

  it("carries slot-local not-found metadata with owner-scoped params", () => {
    const slotNotFound = {};

    expect(
      resolveActiveParallelRouteHeadInputs({
        layoutTreePositions: [1],
        params: { locale: "en", slug: "primary" },
        routeSegments: ["[locale]", "dashboard"],
        slotParams: { sidebar: { member: "alice", slug: "slot" } },
        slots: {
          sidebar: {
            layoutIndex: 0,
            notFound: slotNotFound,
            notFoundTreePosition: 1,
            page: {},
            routeSegments: ["[member]", "[slug]"],
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        notFoundModule: slotNotFound,
        notFoundParams: { locale: "en", member: "alice" },
      }),
    ]);
  });

  it("takes the not-found head from a slot's own file only when its page renders", async () => {
    // Next.js renders an unmatched slot's default.tsx as a `__DEFAULT__`
    // segment without the slot directory's files, so its not-found.tsx never
    // supplies the head; the route's not-found does. A slot page's own does.
    const resolveTitle = async (page: Record<string, unknown> | null) => {
      const metadata = await resolveHttpAccessFallbackMetadata<Record<string, unknown>>({
        boundaryModule: { metadata: { title: "Parent not found" } },
        boundaryParams: {},
        errorConvention: "not-found",
        layoutModules: [{ metadata: { title: "Root layout" } }],
        layoutTreePositions: [0],
        metadataRoutes: [],
        parallelBranches: resolveActiveParallelRouteHeadInputs({
          layoutTreePositions: [0],
          params: {},
          routeSegments: ["panel"],
          slots: {
            panel: {
              layoutIndex: 0,
              notFound: { metadata: { title: "Slot not found" } },
              notFoundTreePosition: 0,
              page,
              routeSegments: page ? [] : null,
            },
          },
        }),
        params: {},
        routePath: "/panel",
        routeSegments: ["panel"],
      });
      return metadata?.title;
    };

    expect(await resolveTitle(null)).toBe("Parent not found");
    expect(await resolveTitle({})).toBe("Slot not found");

    // An intercepted page rendered into the slot is a real segment below the
    // slot root, so the slot root's not-found still applies without a slot page.
    const slotNotFound: Record<string, unknown> = { metadata: { title: "Slot not found" } };
    expect(
      resolveActiveParallelRouteHeadInputs({
        interceptPage: {},
        interceptSlotKey: "panel",
        layoutTreePositions: [0],
        params: {},
        routeSegments: ["panel"],
        slots: {
          panel: { layoutIndex: 0, notFound: slotNotFound, notFoundTreePosition: 0, page: null },
        },
      }),
    ).toEqual([expect.objectContaining({ notFoundModule: slotNotFound })]);
  });

  it("keeps slot-root layout head inputs for intercepted slots", () => {
    const slotLayout = { metadata: { description: "slot root" } };
    const interceptLayout = { metadata: { title: "intercept" } };
    const interceptNotFound = { metadata: { title: "intercept not found" } };
    const interceptPage = {};
    expect(
      resolveActiveParallelRouteHeadInputs({
        interceptLayouts: [interceptLayout],
        interceptBranchSegments: ["[photo]", "[comment]"],
        interceptLayoutSegments: [["[photo]"]],
        interceptNotFound,
        interceptNotFoundTreePosition: 2,
        interceptPage,
        interceptParams: { locale: "en", photo: "42", comment: "7" },
        interceptSlotKey: "modal",
        interceptSourcePageSegments: ["[locale]", "@modal", "(.)photos", "[photo]", "[comment]"],
        layoutTreePositions: [1],
        params: { locale: "en" },
        routeSegments: ["[locale]", "photos"],
        slots: { modal: { layout: slotLayout, layoutIndex: 0 } },
      }),
    ).toEqual([
      {
        head: {
          layoutModules: [slotLayout, interceptLayout],
          layoutParams: [{ locale: "en" }, { locale: "en", photo: "42" }],
          layoutsBesidePage: [false, false],
          layoutTreePositions: [0, 2],
          pageModule: interceptPage,
          params: { locale: "en", photo: "42", comment: "7" },
          routeSegments: ["[locale]", "@modal", "(.)photos", "[photo]", "[comment]"],
        },
        notFoundModule: interceptNotFound,
        notFoundModuleRouteSegments: ["[locale]", "@modal"],
        notFoundParams: { locale: "en", photo: "42", comment: "7" },
        ownerTreePosition: 1,
        slotKey: "modal",
      },
    ]);
  });

  it("scopes a nested intercept not-found before the intercepted child params", () => {
    const interceptNotFound = {};

    expect(
      resolveActiveParallelRouteHeadInputs({
        interceptBranchSegments: ["video", "[id]"],
        interceptNotFoundBranchSegments: ["[locale]", "feed", "video", "[id]"],
        interceptNotFound,
        interceptNotFoundTreePosition: 3,
        interceptPage: {},
        interceptParams: { locale: "en", id: "42" },
        interceptSlotKey: "modal",
        layoutTreePositions: [0],
        params: {},
        routeSegments: ["source"],
        slots: { modal: { layoutIndex: 0 } },
      }),
    ).toEqual([
      expect.objectContaining({
        notFoundModule: interceptNotFound,
        notFoundParams: { locale: "en" },
      }),
    ]);

    expect(
      resolveActiveParallelRouteHeadInputs({
        interceptBranchSegments: ["video", "[id]"],
        interceptNotFoundBranchSegments: ["[locale]", "feed", "video", "[id]"],
        interceptNotFound,
        interceptNotFoundTreePosition: 0,
        interceptPage: {},
        interceptParams: { locale: "en", id: "42" },
        interceptSlotKey: "modal",
        params: {},
        routeSegments: ["source"],
        slots: { modal: {} },
      }),
    ).toEqual([
      expect.objectContaining({
        notFoundModule: interceptNotFound,
        notFoundParams: {},
      }),
    ]);
  });

  it("scopes parallel layout metadata params by tree position", async () => {
    const seen: Record<string, unknown>[] = [];
    const makeLayout = () => ({
      async generateMetadata({ params }: { params: Promise<Record<string, unknown>> }) {
        seen.push(await params);
        return null;
      },
    });

    await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      parallelRoutes: [
        {
          layoutModules: [makeLayout(), makeLayout()],
          layoutTreePositions: [0, 1],
          params: { owner: "root", team: "alpha", member: "bob" },
          routeSegments: ["[team]", "[member]"],
        },
      ],
      params: {},
      routePath: "/alpha/bob",
      routeSegments: [],
    });

    expect(seen).toEqual([{ owner: "root" }, { owner: "root", team: "alpha" }]);
  });

  // Extends Next.js's generateMetadata parent-resolution coverage:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/app/dynamic/%5Bslug%5D/page.tsx
  it("passes the parent to regular generateMetadata with default and rest parameters", async () => {
    const fallbackMetadata = { description: "Fallback description" };
    const receivedArgCounts: number[] = [];
    const withDefault = async function (
      _props: unknown,
      parent = Promise.resolve(fallbackMetadata),
    ) {
      receivedArgCounts.push(arguments.length);
      return { title: String((await parent).description) };
    };
    const withRest = async function (...args: [unknown, Promise<Record<string, unknown>>?]) {
      receivedArgCounts.push(args.length);
      const parent = args[1] ?? Promise.resolve(fallbackMetadata);
      return { title: String((await parent).description) };
    };
    const titles: unknown[] = [];

    for (const generateMetadata of [withDefault, withRest]) {
      const result = await resolveAppPageHead<Record<string, unknown>>({
        layoutModules: [{ metadata: { description: "Root description" } }],
        layoutTreePositions: [0],
        metadataRoutes: [],
        pageModule: { generateMetadata },
        params: {},
        routePath: "/",
        routeSegments: [],
      });
      titles.push(result.metadata?.title);
    }

    expect(withDefault.length).toBe(1);
    expect(withRest.length).toBe(0);
    expect(receivedArgCounts).toEqual([2, 2]);
    expect(titles).toEqual(["Root description", "Root description"]);
  });

  // Regression: a cached `generateMetadata` that does not declare the
  // `parent` argument must NOT receive it. Passing the parent into the cache
  // wrapper feeds it to the cache-key encoder, which throws on non-serializable
  // values such as a `URL` `metadataBase` ("URL objects are not supported").
  it("omits the parent argument for cached generateMetadata that does not declare it", async () => {
    const receivedArgCounts: number[] = [];
    const rootLayout = {
      metadata: {
        metadataBase: new URL("https://example.com"),
        title: "Root",
      },
    };
    const generateMetadata = async function () {
      receivedArgCounts.push(arguments.length);
      return { title: "Page" };
    };
    Object.assign(generateMetadata, {
      [Symbol.for("vinext.useCacheFunction")]: true,
      [Symbol.for("vinext.useCacheAcceptsSecondArgument")]: false,
    });

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: { generateMetadata },
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    // Only `props` was passed (no parent).
    expect(receivedArgCounts).toEqual([1]);
    // metadataBase from the root layout still flows into the resolved metadata.
    expect(result.metadata?.metadataBase).toBeInstanceOf(URL);
    expect(String(result.metadata?.metadataBase)).toBe("https://example.com/");
    expect(result.metadata?.title).toBe("Page");
  });

  it("passes the parent argument to cached generateMetadata that declares it", async () => {
    const receivedArgCounts: number[] = [];
    const rootLayout = {
      metadata: {
        metadataBase: new URL("https://example.com"),
        description: "Root description",
      },
    };
    const generateMetadata = async function (
      _props: unknown,
      parent: Promise<Record<string, unknown>>,
    ) {
      receivedArgCounts.push(arguments.length);
      const parentMetadata = await parent;
      return { title: String(parentMetadata.description) };
    };
    Object.assign(generateMetadata, {
      [Symbol.for("vinext.useCacheFunction")]: true,
    });

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: { generateMetadata },
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    expect(receivedArgCounts).toEqual([2]);
    expect(result.metadata?.title).toBe("Root description");
  });

  // Extends Next.js's cached generateMetadata parent-argument coverage:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/use-cache.test.ts
  it("passes the parent to cached generateMetadata with default and rest parameters", async () => {
    const fallbackMetadata = { description: "Fallback description" };
    const receivedArgCounts: number[] = [];
    const withDefault = async function (
      _props: unknown,
      parent = Promise.resolve(fallbackMetadata),
    ) {
      receivedArgCounts.push(arguments.length);
      return { title: String((await parent).description) };
    };
    const withRest = async function (...args: [unknown, Promise<Record<string, unknown>>?]) {
      receivedArgCounts.push(args.length);
      const parent = args[1] ?? Promise.resolve(fallbackMetadata);
      return { title: String((await parent).description) };
    };
    const titles: unknown[] = [];

    for (const generateMetadata of [withDefault, withRest]) {
      Object.assign(generateMetadata, {
        [Symbol.for("vinext.useCacheFunction")]: true,
        [Symbol.for("vinext.useCacheAcceptsSecondArgument")]: true,
      });
      const result = await resolveAppPageHead<Record<string, unknown>>({
        layoutModules: [{ metadata: { description: "Root description" } }],
        layoutTreePositions: [0],
        metadataRoutes: [],
        pageModule: { generateMetadata },
        params: {},
        routePath: "/",
        routeSegments: [],
      });
      titles.push(result.metadata?.title);
    }

    expect(withDefault.length).toBe(1);
    expect(withRest.length).toBe(0);
    expect(receivedArgCounts).toEqual([2, 2]);
    expect(titles).toEqual(["Root description", "Root description"]);
  });

  it("lets an active slot page's title override the primary page's, as Turbopack orders them", async () => {
    // Turbopack puts `children` before the named slots in the loader tree, so
    // Next.js merges the slot page's metadata, title included, after the page.
    // Next.js 16.2.7 probe: page "TEAM PAGE TITLE" + @members/page "TEAM
    // MEMBERS PAGE TITLE" renders the slot's title with `next build --turbopack`.
    const page = {
      metadata: {
        description: "Primary page",
        title: "Page title",
      },
    };
    const slotPage = {
      metadata: {
        openGraph: {
          title: "Slot OG title",
        },
        title: "Slot page title",
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [{ metadata: { title: "Root" } }],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: page,
      parallelRoutes: [
        {
          pageModule: slotPage,
          routeSegments: ["dashboard"],
        },
      ],
      params: {},
      routePath: "/dashboard",
      routeSegments: ["dashboard"],
    });

    expect(result.metadata).toEqual({
      description: "Primary page",
      openGraph: {
        description: "Primary page",
        title: "Slot OG title",
      },
      title: "Slot page title",
      twitter: {
        card: "summary",
        description: "Primary page",
        title: "Slot OG title",
      },
    });
  });

  it("lets a page's title template wrap a later slot's title, as every item but the last two does", async () => {
    // Next.js's accumulateMetadata lets every loader-tree item but the last two
    // set the template, and each slot adds two items (its directory and its
    // page), so only the last slot's page is among them. Next.js 16.2.7
    // (Turbopack, `next start`) titles all three shapes below this way.
    const resolveTitle = async (
      pageModule: Record<string, unknown>,
      parallelRoutes: {
        layoutModules?: Record<string, unknown>[];
        pageModule: Record<string, unknown>;
      }[],
    ) =>
      (
        await resolveAppPageHead<Record<string, unknown>>({
          layoutModules: [{ metadata: { title: { default: "Root", template: "%s | Root" } } }],
          layoutTreePositions: [0],
          metadataRoutes: [],
          pageModule,
          parallelRoutes,
          params: {},
          routePath: "/",
          routeSegments: [],
        })
      ).metadata?.title;
    const slotA = { pageModule: { metadata: { title: { default: "A", template: "%s | A" } } } };
    const slotB = { pageModule: { metadata: { title: "B" } } };

    // [root layout, page, @a, @a page, @b, @b page]: "Y | X" on /ta.
    expect(await resolveTitle({}, [slotA, slotB])).toBe("B | A");
    // The same with a layout in @b: "Y | X" on /tb.
    expect(await resolveTitle({}, [slotA, { ...slotB, layoutModules: [{}] }])).toBe("B | A");
    // The route's page sets it too when a slot follows: "Y | P" on /tc.
    expect(
      await resolveTitle({ metadata: { title: { default: "P", template: "%s | P" } } }, [slotB]),
    ).toBe("B | P");
  });

  it("resolves each title with the template of the title before it, as Next.js does", async () => {
    // Next.js's accumulateMetadata stashes the resolved title's own template
    // after every loader-tree item but the last two, the page's segment and
    // the page. So a layout's template skips the page beside it, and a title
    // without a template clears it. Each case is titled as Next.js 16.2.7
    // titles it (Turbopack and webpack, `next build`).
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts (accumulateMetadata)
    const template = (name: string, defaultTitle?: string) => ({
      metadata: {
        title: { template: `%s | ${name}`, ...(defaultTitle ? { default: defaultTitle } : {}) },
      },
    });
    const titled = (title: unknown) => ({ metadata: { title } });
    const resolveTitle = async (
      routeSegments: string[],
      layouts: [number, Record<string, unknown>][],
      pageModule: Record<string, unknown>,
      parallelRoutes?: {
        layoutModules?: Record<string, unknown>[];
        layoutsBesidePage?: boolean[];
        pageModule: Record<string, unknown>;
      }[],
    ) =>
      (
        await resolveAppPageHead<Record<string, unknown>>({
          layoutModules: layouts.map(([, module]) => module),
          layoutTreePositions: layouts.map(([position]) => position),
          metadataRoutes: [],
          pageModule,
          parallelRoutes,
          params: {},
          routePath: `/${routeSegments.join("/")}`,
          routeSegments,
        })
      ).metadata?.title;

    // A root layout's template and the home page beside it.
    const acme = template("Acme", "Acme");
    expect(await resolveTitle([], [[0, acme]], titled("Home"))).toBe("Home");
    expect(await resolveTitle(["child"], [[0, acme]], titled("Child"))).toBe("Child | Acme");
    expect(await resolveTitle(["child", "grand"], [[0, acme]], titled("Grand"))).toBe(
      "Grand | Acme",
    );
    expect(await resolveTitle(["notitle"], [[0, acme]], {})).toBe("Acme");

    // `/td` and `/te/child`: a nested layout's template beside its page, and above it.
    const td = template("TD", "TD");
    expect(
      await resolveTitle(
        ["td"],
        [
          [0, {}],
          [1, td],
        ],
        titled("DP"),
      ),
    ).toBe("DP");
    expect(
      await resolveTitle(
        ["td", "child"],
        [
          [0, {}],
          [1, td],
        ],
        titled("EP"),
      ),
    ).toBe("EP | TD");

    // `/tf/mid/leaf`: a plain-string middle layout clears the template.
    const tf: [number, Record<string, unknown>][] = [
      [0, {}],
      [1, template("TF", "TF")],
      [2, titled("Mid")],
    ];
    expect(await resolveTitle(["tf", "mid", "leaf"], tf, titled("Leaf"))).toBe("Leaf");
    expect(await resolveTitle(["tf", "mid", "notitle"], tf, {})).toBe("Mid | TF");

    // `/tg/child`: `title.absolute` skips the template.
    expect(
      await resolveTitle(["tg", "child"], [[1, template("TG", "TG")]], titled({ absolute: "A" })),
    ).toBe("A");

    // `/th`: a template-only layout without a default.
    const th = template("TH");
    expect(await resolveTitle(["th"], [[1, th]], {})).toBeUndefined();
    expect(await resolveTitle(["th", "child"], [[1, th]], titled("Child"))).toBe("Child | TH");

    // `/ti/nested` and `/tj/extra`: a nested layout's template overrides its
    // parent's below it, but not beside its own page.
    const nested: [number, Record<string, unknown>][] = [
      [1, template("TI", "TI")],
      [2, template("NESTED", "Nested")],
    ];
    expect(await resolveTitle(["ti", "nested"], nested, {})).toBe("Nested | TI");
    expect(await resolveTitle(["ti", "nested"], nested, titled("Extra"))).toBe("Extra | TI");
    expect(await resolveTitle(["ti", "nested", "child"], nested, titled("C"))).toBe("C | NESTED");
    expect(await resolveTitle(["ti", "nested", "child", "deep"], nested, {})).toBe("Nested | TI");

    // `/tk`: the last slot's layout template beside its page.
    expect(
      await resolveTitle(["tk"], [[1, template("TK", "TK")]], {}, [
        {
          layoutModules: [template("YL", "YL")],
          layoutsBesidePage: [true],
          pageModule: titled("Y"),
        },
      ]),
    ).toBe("Y | TK");
    // `/tl`: an earlier slot's plain-string page clears its layout's template.
    expect(
      await resolveTitle(["tl"], [[1, template("TL", "TL")]], {}, [
        { layoutModules: [template("XL", "XL")], pageModule: titled("X") },
        { pageModule: titled("Y") },
      ]),
    ).toBe("Y");
  });

  it("treats only an intercepting layout in its page's own directory as beside it", async () => {
    // Next.js 16.2.7 (Turbopack) soft-navigates `/k` to `k/(.)photo/[id]`,
    // titled "Photo", under a root `%s | Root` template: "Photo | Root" when
    // `(.)photo/[id]/layout` is titled "Plain", but "Photo" when
    // `(.)photo/layout` is titled "Mid". The same holds for `/` to `(.)rp/[id]`.
    const root = { metadata: { title: { default: "Root", template: "%s | Root" } } };
    const photo = { metadata: { title: "Photo" } };
    const leaf = { layout: { metadata: { title: "Plain" } }, segments: ["(.)photo", "[id]"] };
    const middle = { layout: { metadata: { title: "Mid" } }, segments: ["(.)photo"] };
    const branchSegments = ["(.)photo", "[id]"];
    const resolveTitle = async (
      routeSegments: string[],
      parallelRoute: AppPageHeadParallelRoute<Record<string, unknown>>,
    ) =>
      (
        await resolveAppPageHead<Record<string, unknown>>({
          layoutModules: [root],
          layoutTreePositions: [0],
          metadataRoutes: [],
          pageModule: null,
          parallelRoutes: [parallelRoute],
          params: {},
          routePath: `/${routeSegments.join("/")}`,
          routeSegments,
        })
      ).metadata?.title;

    // A sibling intercept, which replaces `children`.
    for (const [routeSegments, { layout, segments }, title] of [
      [["k"], leaf, "Photo | Root"],
      [["k"], middle, "Photo"],
      [[], leaf, "Photo | Root"],
      [[], middle, "Photo"],
    ] as const) {
      const layoutsBesidePage = resolveInterceptLayoutsBesidePage([segments], branchSegments);
      expect(
        await resolveTitle([...routeSegments], {
          layoutModules: [layout],
          layoutsBesidePage,
          pageModule: photo,
          routeSegments: [...routeSegments],
        }),
      ).toBe(title);
    }

    // A slot intercept that heads the route.
    for (const [{ layout, segments }, title] of [
      [leaf, "Photo | Root"],
      [middle, "Photo"],
    ] as const) {
      const [input] = resolveActiveParallelRouteHeadInputs({
        interceptBranchSegments: branchSegments,
        interceptLayoutSegments: [segments],
        interceptLayouts: [layout],
        interceptPage: photo,
        interceptSlotKey: "modal",
        interceptSourcePageSegments: ["g", "@modal", ...branchSegments],
        layoutTreePositions: [0],
        params: {},
        routeSegments: ["g"],
        slots: { modal: { layoutIndex: 0 } },
      });
      expect(await resolveTitle(["g"], input.head)).toBe(title);
    }
  });

  it("counts a slot page's route groups as segments between it and the slot's layouts", async () => {
    // Next.js 16.2.7 (Turbopack) titles `/s` "Grouped Page | Slot" for
    // `@slot/layout` with a template and `@slot/(group)/page`, and `/u`
    // "Deep Page | A" for `@slot/(a)/layout` and `@slot/(a)/(b)/page`: each
    // route group is a loader-tree segment, though `routeSegments` is `[]`.
    const root = { metadata: { title: { default: "Root", template: "%s | Root" } } };
    const slotLayout = { metadata: { title: { default: "Slot", template: "%s | Slot" } } };
    const groupLayout = { metadata: { title: { default: "A", template: "%s | A" } } };
    const resolveTitle = async (slot: {
      configLayouts?: Record<string, unknown>[];
      configLayoutTreePositions?: number[];
      page: Record<string, unknown>;
      pageTreePosition: number;
    }) => {
      const parallelRoutes = resolveActiveParallelRouteHeadInputs({
        layoutTreePositions: [0, 1],
        params: {},
        routeSegments: ["s"],
        slots: { slot: { ...slot, layout: slotLayout, layoutIndex: 1, routeSegments: [] } },
      }).map((input) => input.head);
      return (
        await resolveAppPageHead<Record<string, unknown>>({
          layoutModules: [root, {}],
          layoutTreePositions: [0, 1],
          metadataRoutes: [],
          pageModule: {},
          parallelRoutes,
          params: {},
          routePath: "/s",
          routeSegments: ["s"],
        })
      ).metadata?.title;
    };

    expect(
      await resolveTitle({ page: { metadata: { title: "Grouped Page" } }, pageTreePosition: 1 }),
    ).toBe("Grouped Page | Slot");
    expect(
      await resolveTitle({
        configLayouts: [groupLayout],
        configLayoutTreePositions: [1],
        page: { metadata: { title: "Deep Page" } },
        pageTreePosition: 2,
      }),
    ).toBe("Deep Page | A");
    // `/t`: without the group, the slot's layout is beside its page.
    expect(
      await resolveTitle({ page: { metadata: { title: "Direct Page" } }, pageTreePosition: 0 }),
    ).toBe("Direct Page | Root");
  });

  it("hands a page the template of the title before it, even one it doesn't apply", async () => {
    // Next.js's `parent` is its ResolvedMetadata, whose title keeps the last
    // title's own template, even one the page beside it doesn't get.
    const seenTitles: unknown[] = [];
    const page = {
      async generateMetadata(_props: unknown, parent: Promise<Record<string, unknown>>) {
        seenTitles.push((await parent).title);
        return { title: "Page" };
      },
    };
    const resolveTitle = async (routeSegments: string[], layouts: Record<string, unknown>[]) =>
      (
        await resolveAppPageHead<Record<string, unknown>>({
          layoutModules: layouts,
          layoutTreePositions: layouts.map((_, index) => index),
          metadataRoutes: [],
          pageModule: page,
          params: {},
          routePath: `/${routeSegments.join("/")}`,
          routeSegments,
        })
      ).metadata?.title;
    const site = { metadata: { title: { default: "Site", template: "%s | Site" } } };

    // A plain-string layout beside the page clears the template it hands on,
    // but the page still gets the one from before that layout.
    expect(await resolveTitle(["mid"], [site, { metadata: { title: "Mid" } }])).toBe("Page | Site");
    // Above the page, it clears the template for the page too.
    expect(await resolveTitle(["mid", "leaf"], [site, { metadata: { title: "Mid" } }])).toBe(
      "Page",
    );
    // A template beside the page reaches it in `parent` without wrapping it.
    expect(await resolveTitle([], [site])).toBe("Page");
    expect(seenTitles).toEqual([
      { absolute: "Mid | Site", template: null },
      { absolute: "Mid | Site", template: null },
      { absolute: "Site", template: "%s | Site" },
    ]);
  });

  it("resolves openGraph and twitter titles with their own templates, as Next.js does", async () => {
    // Next.js's accumulateMetadata stashes `titleTemplates.openGraph` and
    // `.twitter` under the same `i < metadataItems.length - 2` rule as
    // `title`'s. Each case is titled as Next.js 16.2.7 titles it (Turbopack
    // and webpack, `next dev`).
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts (accumulateMetadata)
    const seenTitles: unknown[] = [];
    const social = {
      metadata: {
        openGraph: { title: { template: "%s | OG", default: "OG Default" } },
        twitter: { title: { template: "%s | TW", default: "TW Default" } },
      },
    };
    const titled = (title: string) => ({
      async generateMetadata(_props: unknown, parent: Promise<Record<string, unknown>>) {
        const resolved = await parent;
        seenTitles.push([resolved.openGraph, resolved.twitter]);
        return { openGraph: { title }, twitter: { title } };
      },
    });
    const resolveSocialTitles = async (
      routeSegments: string[],
      layouts: [number, Record<string, unknown>][],
      pageModule: Record<string, unknown>,
    ) => {
      const { metadata } = await resolveAppPageHead<Record<string, unknown>>({
        layoutModules: layouts.map(([, module]) => module),
        layoutTreePositions: layouts.map(([position]) => position),
        metadataRoutes: [],
        pageModule,
        params: {},
        routePath: `/${routeSegments.join("/")}`,
        routeSegments,
      });
      return [metadata?.openGraph?.title, metadata?.twitter?.title];
    };

    // `/social`: the layout's templates skip the page beside it.
    expect(await resolveSocialTitles(["social"], [[1, social]], titled("Beside"))).toEqual([
      "Beside",
      "Beside",
    ]);
    // `/social/child`: they wrap a deeper page's titles, and `parent` holds
    // each title as `{ absolute, template }`.
    expect(await resolveSocialTitles(["social", "child"], [[1, social]], titled("Child"))).toEqual([
      "Child | OG",
      "Child | TW",
    ]);
    expect(seenTitles.at(-1)).toEqual([
      { title: { absolute: "OG Default", template: "%s | OG" } },
      { title: { absolute: "TW Default", template: "%s | TW" } },
    ]);
    // `/social/inherit`: a page without them shows the layout's defaults.
    expect(await resolveSocialTitles(["social", "inherit"], [[1, social]], {})).toEqual([
      "OG Default",
      "TW Default",
    ]);
    // `/social/extra`: a template beside the page gives way to the one above it.
    const extra = {
      metadata: { openGraph: { title: { template: "%s | Extra OG", default: "Extra" } } },
    };
    expect(
      await resolveSocialTitles(
        ["social", "extra"],
        [
          [1, social],
          [2, extra],
        ],
        { metadata: { openGraph: { title: "Extra" } } },
      ),
    ).toEqual(["Extra | OG", "TW Default"]);
    // `/social/plain/leaf`: a plain-string title, or a value without a title,
    // clears the template.
    const plain = {
      metadata: { openGraph: { title: "Plain OG" }, twitter: { description: "Plain TW" } },
    };
    expect(
      await resolveSocialTitles(
        ["social", "plain", "leaf"],
        [
          [1, social],
          [2, plain],
        ],
        titled("Leaf"),
      ),
    ).toEqual(["Leaf", "Leaf"]);
    // `/social/og-only`: a missing twitter title comes from openGraph's.
    expect(
      await resolveSocialTitles(["social", "og-only"], [[1, social]], {
        metadata: { openGraph: { title: "OG Only" }, twitter: { card: "summary" } },
      }),
    ).toEqual(["OG Only | OG", "OG Only | OG"]);
    // `/social/cleared`: a layout beside the page that clears them still
    // hands the page the templates from before it.
    expect(
      await resolveSocialTitles(
        ["social", "cleared"],
        [
          [1, social],
          [2, { metadata: { openGraph: null, twitter: undefined } }],
        ],
        titled("Page"),
      ),
    ).toEqual(["Page | OG", "Page | TW"]);
    expect(seenTitles.at(-1)).toEqual([null, undefined]);
  });

  it("hands each resolver the title resolved before it as { absolute, template }", async () => {
    // Next.js passes each resolver its ResolvedMetadata, whose title keeps the
    // template the next title gets beside the resolved string.
    const seenTitles: Record<string, unknown> = {};
    const reader = (source: string, metadata: Record<string, unknown> = {}) => ({
      async generateMetadata(_props: unknown, parent: Promise<Record<string, unknown>>) {
        seenTitles[source] = (await parent).title;
        return metadata;
      },
    });
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [
        { metadata: { title: { default: "Root", template: "%s | Root" } } },
        reader("nested layout"),
      ],
      layoutTreePositions: [0, 1],
      metadataRoutes: [],
      pageModule: reader("page"),
      parallelRoutes: [
        { pageModule: { metadata: { title: { default: "Alpha", template: "%s | Alpha" } } } },
        { pageModule: reader("second slot") },
      ],
      params: {},
      routePath: "/feed",
      routeSegments: ["feed"],
    });

    expect(seenTitles).toEqual({
      "nested layout": { absolute: "Root", template: "%s | Root" },
      page: { absolute: "Root", template: "%s | Root" },
      "second slot": { absolute: "Alpha | Root", template: "%s | Alpha" },
    });
    expect(result.metadata?.title).toBe("Alpha | Root");
  });

  it("hands each slot the metadata resolved before it in the loader tree", async () => {
    // Next.js calls every generateMetadata() with the metadata merged from
    // everything before it: the layouts, the page, then each earlier slot.
    const seenParents: Record<string, unknown>[] = [];
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [{ metadata: { description: "Root" } }],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: { metadata: { applicationName: "Feed" } },
      parallelRoutes: [
        { pageModule: { metadata: { creator: "Alpha", title: "Alpha" } } },
        {
          pageModule: {
            async generateMetadata(_props: unknown, parent: Promise<Record<string, unknown>>) {
              seenParents.push(await parent);
              return { publisher: "Beta" };
            },
          },
        },
      ],
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    expect(seenParents).toEqual([
      expect.objectContaining({
        applicationName: "Feed",
        creator: "Alpha",
        description: "Root",
        title: { absolute: "Alpha", template: null },
      }),
    ]);
    expect(result.metadata).toMatchObject({ publisher: "Beta" });
  });

  it("calls a cached slot resolver that reads its parent once that parent settles", async () => {
    // Next.js starts every generateMetadata() up front except a "use cache"
    // one that reads `parent`: encoding its arguments waits for the parent,
    // which another cached resolver may still be computing, so it runs once
    // that parent settles (resolve-metadata.ts getResult).
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
    const calls: string[] = [];
    let releaseLayout: (() => void) | undefined;
    const layoutGate = new Promise<void>((resolve) => {
      releaseLayout = resolve;
    });
    const cached = <T extends object>(fn: T) =>
      Object.assign(fn, {
        [Symbol.for("vinext.useCacheFunction")]: true,
        [Symbol.for("vinext.useCacheAcceptsSecondArgument")]: true,
      });
    const seenPageParents: Record<string, unknown>[] = [];
    const slotLayout = {
      generateMetadata: cached(async (_props: unknown, parent: Promise<unknown>) => {
        calls.push("layout");
        await parent;
        await layoutGate;
        return { creator: "Slot layout" };
      }),
    };
    const slotPage = {
      generateMetadata: cached(
        async (_props: unknown, parent: Promise<Record<string, unknown>>) => {
          calls.push("page");
          seenPageParents.push(await parent);
          return { title: "Slot page" };
        },
      ),
    };

    const prepared = prepareAppPageHead<Record<string, unknown>>({
      layoutModules: [{ metadata: { description: "Root" } }],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: { metadata: { applicationName: "Feed" } },
      parallelRoutes: [{ layoutModules: [slotLayout], layoutParams: [{}], pageModule: slotPage }],
      params: {},
      routePath: "/",
      routeSegments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["layout"]);

    releaseLayout?.();
    await expect(prepared.metadata).resolves.toMatchObject({
      creator: "Slot layout",
      title: "Slot page",
    });
    expect(calls).toEqual(["layout", "page"]);
    expect(seenPageParents).toEqual([
      expect.objectContaining({ applicationName: "Feed", creator: "Slot layout" }),
    ]);
  });

  it("calls a cached slot generateViewport() that reads its parent once that parent settles", async () => {
    // Next.js's getResult defers a "use cache" generateViewport() that reads
    // `parent` as it does generateMetadata(): its cache key waits for that
    // parent, which another cached resolver may still be computing.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts (getResult)
    const calls: string[] = [];
    let releaseLayout: (() => void) | undefined;
    const layoutGate = new Promise<void>((resolve) => {
      releaseLayout = resolve;
    });
    const cached = <T extends object>(fn: T) =>
      Object.assign(fn, {
        [Symbol.for("vinext.useCacheFunction")]: true,
        [Symbol.for("vinext.useCacheAcceptsSecondArgument")]: true,
      });
    const seenPageParents: Record<string, unknown>[] = [];
    const slotLayout = {
      generateViewport: cached(async (_props: unknown, parent: Promise<unknown>) => {
        calls.push("layout");
        await parent;
        await layoutGate;
        return { themeColor: "#111111" };
      }),
    };
    const interceptPage = {
      generateViewport: cached(
        async (_props: unknown, parent: Promise<Record<string, unknown>>) => {
          calls.push("page");
          seenPageParents.push(await parent);
          return { colorScheme: "dark" as const };
        },
      ),
    };
    const slotLayoutBranch = { layoutModules: [slotLayout], layoutParams: [{}] };

    const prepared = prepareAppPageHead<Record<string, unknown>>({
      hiddenParallelRoutes: [
        {
          parallelRouteIndex: 0,
          route: { ...slotLayoutBranch, pageModule: interceptPage },
          sharedLayoutCount: 1,
        },
      ],
      layoutModules: [{ viewport: { width: 400 } }],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: { metadata: { title: "Feed page" } },
      parallelRoutes: [slotLayoutBranch],
      params: {},
      routePath: "/",
      routeSegments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["layout"]);

    releaseLayout?.();
    await expect(prepared.routeErrors).resolves.toBeNull();
    expect(calls).toEqual(["layout", "page"]);
    expect(seenPageParents).toEqual([
      expect.objectContaining({ themeColor: [{ color: "#111111" }], width: 400 }),
    ]);
  });

  it("omits the parent for a cached generateViewport() that does not declare it", async () => {
    const receivedArgCounts: number[] = [];
    const generateViewport = async function () {
      receivedArgCounts.push(arguments.length);
      return { themeColor: "#222222" };
    };
    Object.assign(generateViewport, {
      [Symbol.for("vinext.useCacheFunction")]: true,
      [Symbol.for("vinext.useCacheAcceptsSecondArgument")]: false,
    });

    await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      pageModule: { generateViewport },
      params: {},
      routePath: "/",
      routeSegments: [],
    });
    expect(receivedArgCounts).toEqual([1]);
  });

  it("fails with an earlier segment's delayed signal over a later one's immediate one", async () => {
    // Next.js starts every generateMetadata() and generateViewport() up front,
    // but accumulateMetadata and accumulateViewport await their results in
    // loader-tree order, so the earlier segment's signal wins.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
    const notFoundError = Object.assign(new Error("NEXT_NOT_FOUND"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/elsewhere;307;",
    });
    const delayedNotFound = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw notFoundError;
    };
    const immediateRedirect = () => {
      throw redirectError;
    };
    // Either a slot's layout or a hidden intercept after that slot is
    // delayed, and a later slot's page throws at once.
    const prepare = (key: "generateMetadata" | "generateViewport", hidden: boolean) =>
      prepareAppPageHead<Record<string, unknown>>({
        hiddenParallelRoutes: hidden
          ? [
              {
                parallelRouteIndex: 0,
                route: { pageModule: { [key]: delayedNotFound } },
                sharedLayoutCount: 0,
              },
            ]
          : null,
        layoutModules: [],
        metadataRoutes: [],
        pageModule: { metadata: { title: "Feed page" } },
        parallelRoutes: [
          hidden
            ? { pageModule: { metadata: { description: "Feed slot" } } }
            : { layoutModules: [{ [key]: delayedNotFound }], layoutParams: [{}], pageModule: {} },
          { pageModule: { [key]: immediateRedirect } },
        ],
        params: {},
        routePath: "/",
        routeSegments: [],
      });

    for (const key of ["generateMetadata", "generateViewport"] as const) {
      const fromSlot = prepare(key, false);
      await expect(fromSlot.routeErrors).rejects.toBe(notFoundError);
      await expect(key === "generateMetadata" ? fromSlot.metadata : fromSlot.viewport).rejects.toBe(
        notFoundError,
      );
      // A hidden intercept's own error throws in its slot, and the later
      // slot's is the route's.
      const fromHidden = prepare(key, true);
      await expect(fromHidden.hiddenErrors).rejects.toBe(notFoundError);
      await expect(fromHidden.routeErrors).rejects.toBe(redirectError);
    }
  });

  it("starts a hidden slot intercept in its slot's place in the loader tree", async () => {
    // Next.js's prerenderMetadata and prerenderViewport call every resolver in
    // loader-tree order, where the intercept takes its slot's place: after the
    // slot's shared layout, before the next slot.
    for (const key of ["generateMetadata", "generateViewport"] as const) {
      const started: string[] = [];
      const segment = (name: string) => ({
        [key]() {
          started.push(name);
          return {};
        },
      });
      const prepared = prepareAppPageHead<Record<string, unknown>>({
        hiddenParallelRoutes: [
          {
            parallelRouteIndex: 0,
            route: {
              layoutModules: [segment("modal layout"), segment("intercept layout")],
              layoutParams: [{}, {}],
              pageModule: segment("intercept page"),
            },
            sharedLayoutCount: 1,
          },
        ],
        layoutModules: [segment("root layout")],
        layoutTreePositions: [0],
        metadataRoutes: [],
        pageModule: segment("page"),
        parallelRoutes: [
          {
            layoutModules: [segment("modal layout")],
            layoutParams: [{}],
            pageModule: segment("modal page"),
          },
          { pageModule: segment("later slot page") },
        ],
        params: {},
        routePath: "/",
        routeSegments: [],
      });
      await prepared.routeErrors;
      expect(started, key).toEqual([
        "root layout",
        "page",
        "modal layout",
        "intercept layout",
        "intercept page",
        "modal page",
        "later slot page",
      ]);
    }
  });

  it("reads each shown value once, when the walk merges it", async () => {
    // Next.js's accumulateMetadata merges each item once, so a getter that
    // only works on its first read still resolves.
    let reads = 0;
    const onceOnly = () => ({
      get description(): string {
        reads++;
        if (reads > 1) throw new Error("read twice");
        return "Once";
      },
    });
    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      pageModule: { metadata: { title: "Feed page" } },
      parallelRoutes: [{ pageModule: { generateMetadata: onceOnly } }],
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    expect(result.metadata).toMatchObject({ description: "Once", title: "Feed page" });
    expect(reads).toBe(1);
  });

  it("fails with an earlier item's merge error over a later hidden intercept's signal", async () => {
    // Next.js's accumulateMetadata and accumulateViewport merge each value as
    // they reach it, so a value that throws while merging, here a getter that
    // calls notFound(), fails at its own place in the loader tree: before a
    // later intercept's redirect(), and without waiting for one that hangs.
    const notFoundError = Object.assign(new Error("NEXT_NOT_FOUND"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/elsewhere;307;",
    });
    const throwingValue = {
      generateMetadata: () => ({
        get description(): string {
          throw notFoundError;
        },
      }),
      generateViewport: () => ({
        themeColor: {
          get color(): string {
            throw notFoundError;
          },
        },
      }),
    };
    for (const key of ["generateMetadata", "generateViewport"] as const) {
      for (const hiddenResult of ["redirect", "pending"] as const) {
        const prepared = prepareAppPageHead<Record<string, unknown>>({
          hiddenParallelRoutes: [
            {
              parallelRouteIndex: 1,
              route: {
                pageModule: {
                  [key]:
                    hiddenResult === "redirect"
                      ? () => {
                          throw redirectError;
                        }
                      : () => new Promise(() => {}),
                },
              },
              sharedLayoutCount: 0,
            },
          ],
          layoutModules: [],
          metadataRoutes: [],
          pageModule: { metadata: { title: "Feed page" } },
          parallelRoutes: [
            { pageModule: { [key]: throwingValue[key] } },
            { pageModule: { metadata: { description: "Modal slot" } } },
          ],
          params: {},
          routePath: "/",
          routeSegments: [],
        });
        await expect(prepared.routeErrors, `${key} ${hiddenResult}`).rejects.toBe(notFoundError);
        await expect(
          key === "generateMetadata" ? prepared.metadata : prepared.viewport,
          `${key} ${hiddenResult}`,
        ).rejects.toBe(notFoundError);
      }
    }
  });

  it("resolves a slot intercept's head once, after everything before it in the loader tree", async () => {
    // Next.js renders one loader tree, so the modal slot's layout runs once
    // and the intercepting page's parent holds the layouts, the source page,
    // every earlier slot, and the slot's layout.
    const slotLayout = {
      generateMetadata: vi.fn(async () => ({ creator: "Modal layout" })),
      generateViewport: vi.fn(() => ({ themeColor: "#000000" })),
    };
    const seenInterceptParents: Record<string, unknown>[] = [];
    const interceptPage = {
      async generateMetadata(_props: unknown, parent: Promise<Record<string, unknown>>) {
        seenInterceptParents.push(await parent);
        return { title: "Intercept" };
      },
      generateViewport: vi.fn(() => ({ colorScheme: "dark" as const })),
    };
    const slotLayoutBranch = { layoutModules: [slotLayout], layoutParams: [{}] };

    const prepared = prepareAppPageHead<Record<string, unknown>>({
      hiddenParallelRoutes: [
        {
          parallelRouteIndex: 1,
          route: { ...slotLayoutBranch, pageModule: interceptPage },
          sharedLayoutCount: 1,
        },
      ],
      layoutModules: [{ metadata: { description: "Root" } }],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: { metadata: { applicationName: "Feed", title: "Feed page" } },
      parallelRoutes: [{ pageModule: { metadata: { keywords: ["alpha"] } } }, slotLayoutBranch],
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    await expect(prepared.metadata).resolves.toMatchObject({ title: "Feed page" });
    await prepared.viewport;
    await prepared.hiddenErrors;
    expect(slotLayout.generateMetadata).toHaveBeenCalledTimes(1);
    expect(slotLayout.generateViewport).toHaveBeenCalledTimes(1);
    expect(interceptPage.generateViewport).toHaveBeenCalledTimes(1);
    expect(seenInterceptParents).toEqual([
      expect.objectContaining({
        applicationName: "Feed",
        creator: "Modal layout",
        description: "Root",
        keywords: ["alpha"],
      }),
    ]);
  });

  it("leaves a shown slot's own errors to its outlet, and an earlier one to the route's", async () => {
    // Next.js throws a heading slot intercept's metadata errors in its page's
    // segment. One its parent rejected with first, such as a layout's, still
    // reaches the route, as later branches inherit it too.
    const interceptError = new Error("intercept");
    const layoutError = new Error("layout");
    const prepare = (layoutThrows: boolean) =>
      prepareAppPageHead<Record<string, unknown>>({
        layoutModules: [
          layoutThrows
            ? {
                generateMetadata() {
                  throw layoutError;
                },
              }
            : { metadata: { title: "Layout" } },
        ],
        layoutTreePositions: [0],
        metadataRoutes: [],
        outletParallelRouteIndex: 0,
        parallelRoutes: [
          {
            pageModule: {
              generateMetadata() {
                throw interceptError;
              },
            },
          },
          { pageModule: { metadata: { keywords: ["later"] } } },
        ],
        params: {},
        routePath: "/",
        routeSegments: [],
      });

    const own = prepare(false);
    await expect(own.metadata).rejects.toBe(interceptError);
    await expect(own.hiddenErrors).rejects.toBe(interceptError);
    await expect(own.routeErrors).resolves.toBeNull();

    const inherited = prepare(true);
    await expect(inherited.routeErrors).rejects.toBe(layoutError);
    await expect(inherited.hiddenErrors).resolves.toBeNull();
  });

  it("fails the route on its viewport error while a shown slot's own metadata is still pending", async () => {
    // A viewport error is checked against the outlet's viewport only, so it
    // never waits on the outlet's generateMetadata().
    const viewportError = new Error("viewport");
    const prepared = prepareAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      outletParallelRouteIndex: 0,
      pageModule: {
        generateViewport() {
          throw viewportError;
        },
      },
      parallelRoutes: [{ pageModule: { generateMetadata: () => new Promise(() => {}) } }],
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    const timedOut = Symbol("timed out");
    const outcome = await Promise.race([
      prepared.routeErrors.then(
        () => null,
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(resolve, 200, timedOut)),
    ]);
    expect(outcome).toBe(viewportError);
  });

  it("leaves a source page's error to the route, not a hidden slot intercept that inherits it", async () => {
    // Next.js accumulates metadata in loader-tree order, so the source page's
    // error comes first: it throws once, on the route, never also in the modal.
    for (const kind of ["generateMetadata", "generateViewport"] as const) {
      const pageError = new Error(`source page ${kind}`);
      const prepared = prepareAppPageHead<Record<string, unknown>>({
        hiddenParallelRoutes: [
          {
            parallelRouteIndex: 0,
            route: {
              pageModule: {
                async [kind](_props: unknown, parent: Promise<unknown>) {
                  await parent;
                  return {};
                },
              },
            },
            sharedLayoutCount: 0,
          },
        ],
        layoutModules: [],
        metadataRoutes: [],
        pageModule: {
          [kind]() {
            throw pageError;
          },
        },
        parallelRoutes: [{ pageModule: { metadata: { description: "Feed slot" } } }],
        params: {},
        routePath: "/",
        routeSegments: [],
      });

      await expect(prepared.routeErrors, kind).rejects.toBe(pageError);
      await expect(prepared.hiddenErrors, kind).resolves.toBeNull();
    }
  });

  it("fails the route on a later slot's error while a shown slot's own metadata is still pending", async () => {
    // The route checks each resolver's error as it rejects, so an outlet slot
    // whose generateMetadata() never settles can't hold a later slot's error.
    const laterError = new Error("later slot");
    const prepared = prepareAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      outletParallelRouteIndex: 0,
      parallelRoutes: [
        { pageModule: { generateMetadata: () => new Promise(() => {}) } },
        {
          pageModule: {
            generateMetadata() {
              throw laterError;
            },
          },
        },
      ],
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    const timedOut = Symbol("timed out");
    const outcome = await Promise.race([
      prepared.routeErrors.then(
        () => null,
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(resolve, 200, timedOut)),
    ]);
    expect(outcome).toBe(laterError);
  });

  it("never holds the route's errors behind the outlet slot", async () => {
    // The route's errors never wait on the outlet slot, whose resolvers may
    // never settle. A later route item's resolver error counts in loader-tree
    // order until it reads `parent`. What only the outlet slot settling makes
    // known, a failed merge or an error after reading `parent`, counts after
    // every error in place, so an in-place error beats an earlier deferred one.
    const pending = Symbol("pending");
    const outletError = new Error("outlet slot");
    const laterError = new Error("later slot");
    const kinds = [
      {
        key: "generateMetadata",
        middle: { description: "middle" },
        value: { description: "value" },
      },
      {
        key: "generateViewport",
        failsToMerge: { themeColor: [null] },
        middle: { themeColor: "red" },
        value: { colorScheme: "dark" },
      },
    ] as const;
    const cases = kinds.flatMap((kind) => {
      const outlets = {
        pending: () => new Promise(() => {}),
        rejected() {
          throw outletError;
        },
        resolved: () => kind.value,
      };
      const middles: Record<string, Record<string, unknown>> = {
        absent: {},
        null: { [kind.key]: () => null },
        value: { [kind.key]: () => kind.middle },
        "reads parent": {
          async [kind.key](_props: unknown, parent: Promise<unknown>) {
            await parent;
            return kind.middle;
          },
        },
        ...("failsToMerge" in kind
          ? { "fails to merge": { [kind.key]: () => kind.failsToMerge } }
          : {}),
      };
      const laters = {
        throws() {
          throw laterError;
        },
        resolves: () => kind.value,
        async "reads parent, then throws"(_props: unknown, parent: Promise<unknown>) {
          await parent;
          throw laterError;
        },
      };
      return Object.entries(outlets).flatMap(([outlet, outletResolver]) =>
        Object.entries(middles).flatMap(([middle, middleModule]) =>
          Object.entries(laters).map(([later, laterResolver]) => {
            const prepared = prepareAppPageHead<Record<string, unknown>>({
              layoutModules: [],
              metadataRoutes: [],
              outletParallelRouteIndex: 0,
              parallelRoutes: [
                { pageModule: { [kind.key]: outletResolver } },
                { pageModule: middleModule },
                { pageModule: { [kind.key]: laterResolver } },
              ],
              params: {},
              routePath: "/",
              routeSegments: [],
            });
            const expected =
              later === "throws"
                ? laterError
                : outlet === "pending"
                  ? pending
                  : outlet === "rejected"
                    ? null
                    : middle === "fails to merge"
                      ? TypeError
                      : later === "resolves"
                        ? null
                        : laterError;
            const label = `${kind.key}: ${outlet} outlet, ${middle} middle, later ${later}`;
            return { expected, label, prepared };
          }),
        ),
      );
    });

    const timeout = new Promise((resolve) => setTimeout(resolve, 100, pending));
    const outcomes = await Promise.all(
      cases.map(({ prepared }) =>
        Promise.race([
          prepared.routeErrors.then(
            () => null,
            (error: unknown) => error,
          ),
          timeout,
        ]),
      ),
    );
    for (const [index, { expected, label }] of cases.entries()) {
      if (expected === TypeError) expect(outcomes[index], label).toBeInstanceOf(TypeError);
      else expect(outcomes[index], label).toBe(expected);
    }
  });

  it("settles the route while the outlet slot's generateViewport() is pending after its generateMetadata() failed", async () => {
    // The route's errors never wait on the outlet branch, so its pending
    // counterpart can't keep the route's outlet suspended.
    const outletError = new Error("outlet slot");
    const prepared = prepareAppPageHead<Record<string, unknown>>({
      layoutModules: [],
      metadataRoutes: [],
      outletParallelRouteIndex: 0,
      parallelRoutes: [
        {
          pageModule: {
            generateMetadata() {
              throw outletError;
            },
            generateViewport: () => new Promise(() => {}),
          },
        },
      ],
      params: {},
      routePath: "/",
      routeSegments: [],
    });

    const timedOut = Symbol("timed out");
    const settle = (errors: Promise<null>) =>
      Promise.race([
        errors.then(
          () => "resolved",
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(resolve, 200, timedOut)),
      ]);
    expect(await settle(prepared.hiddenErrors)).toBe(outletError);
    expect(await settle(prepared.routeErrors)).toBe("resolved");
  });

  it("throws the outlet slot's earlier delayed signal over its later immediate one", async () => {
    // Its own errors, too, are taken in loader-tree order.
    const notFoundError = Object.assign(new Error("NEXT_NOT_FOUND"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/elsewhere;307;",
    });
    for (const key of ["generateMetadata", "generateViewport"] as const) {
      const prepared = prepareAppPageHead<Record<string, unknown>>({
        layoutModules: [],
        metadataRoutes: [],
        outletParallelRouteIndex: 0,
        parallelRoutes: [
          {
            layoutModules: [
              {
                async [key]() {
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  throw notFoundError;
                },
              },
            ],
            layoutParams: [{}],
            pageModule: {
              [key]() {
                throw redirectError;
              },
            },
          },
        ],
        params: {},
        routePath: "/",
        routeSegments: [],
      });
      await expect(prepared.hiddenErrors, key).rejects.toBe(notFoundError);
      await expect(prepared.routeErrors, key).resolves.toBeNull();
    }
  });

  it("fails the route on a later slot's own error even when it is the outlet slot's error", async () => {
    // Only an error a later slot took from the outlet through `parent` stays
    // the outlet's. The slot's own, even the same shared error, is the route's.
    const sharedError = new Error("boom");
    for (const key of ["generateMetadata", "generateViewport"] as const) {
      const prepare = (laterReadsParent: boolean) =>
        prepareAppPageHead<Record<string, unknown>>({
          layoutModules: [],
          metadataRoutes: [],
          outletParallelRouteIndex: 0,
          parallelRoutes: [
            {
              pageModule: {
                [key]() {
                  throw sharedError;
                },
              },
            },
            {
              pageModule: laterReadsParent
                ? {
                    async [key](_props: unknown, parent: Promise<unknown>) {
                      await parent;
                      return {};
                    },
                  }
                : {
                    [key]() {
                      throw sharedError;
                    },
                  },
            },
          ],
          params: {},
          routePath: "/",
          routeSegments: [],
        });

      const own = prepare(false);
      await expect(own.hiddenErrors, key).rejects.toBe(sharedError);
      await expect(own.routeErrors, key).rejects.toBe(sharedError);

      const inherited = prepare(true);
      await expect(inherited.hiddenErrors, key).rejects.toBe(sharedError);
      await expect(inherited.routeErrors, key).resolves.toBeNull();
    }
  });

  it("throws a value that fails to merge as its own item's error, even when a later slot inherits it", async () => {
    // Every generateViewport() can resolve and merging one still throw, as on
    // JavaScript's `themeColor: [null]`. Next.js's accumulateViewport merges
    // each value at its own place in the loader tree, so the failure is that
    // item's: the route's for its page, the outlet slot's for that slot. A
    // later slot that awaits `parent` takes the failure from it, which stays
    // the earlier item's.
    const laterSlot = {
      pageModule: {
        async generateViewport(_props: unknown, parent: Promise<unknown>) {
          await parent;
          return {};
        },
      },
    };
    const prepare = (owner: "page" | "slot", outletParallelRouteIndex: number | null) =>
      prepareAppPageHead<Record<string, unknown>>({
        layoutModules: [],
        metadataRoutes: [],
        outletParallelRouteIndex,
        pageModule:
          owner === "page"
            ? { generateViewport: () => ({ themeColor: [null] }) }
            : { metadata: {} },
        parallelRoutes: [
          owner === "slot"
            ? { pageModule: { generateViewport: () => ({ themeColor: [null] }) } }
            : { pageModule: { metadata: { title: "Slot" } } },
          laterSlot,
        ],
        params: {},
        routePath: "/",
        routeSegments: [],
      });

    for (const [owner, outletParallelRouteIndex, failing] of [
      ["page", null, "routeErrors"],
      ["page", 0, "routeErrors"],
      ["slot", null, "routeErrors"],
      ["slot", 0, "hiddenErrors"],
    ] as const) {
      const label = `${owner} with outlet ${outletParallelRouteIndex}`;
      const prepared = prepare(owner, outletParallelRouteIndex);
      const mergeError: unknown = await prepared.viewport.catch((error: unknown) => error);
      expect(mergeError, label).toBeInstanceOf(TypeError);
      await expect(prepared[failing], label).rejects.toBe(mergeError);
      await expect(
        prepared[failing === "routeErrors" ? "hiddenErrors" : "routeErrors"],
        label,
      ).resolves.toBeNull();
    }
  });

  it("uses parallel route slot page title when no primary page module is present", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming-parallel-routes/metadata-streaming-parallel-routes.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming-parallel-routes/metadata-streaming-parallel-routes.test.ts
    //
    // Reproduces:
    //   "should change metadata when navigating between two pages under a slot
    //   when children is not rendered"
    //
    // The route has no `pageModule` (the layout doesn't render children and there
    // is no children-slot default to fill in). The active title must come from
    // the parallel slot's page metadata.
    const rootLayout = {
      metadata: {
        title: "Root",
      },
    };
    const parallelLayout = {
      metadata: {
        title: "parallel-routes-no-children layout title",
      },
    };
    const slotPage = {
      metadata: {
        title: "first page - @bar",
      },
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout, parallelLayout],
      layoutTreePositions: [0, 1],
      metadataRoutes: [],
      pageModule: null,
      parallelRoutes: [
        {
          layoutModules: [],
          pageModule: slotPage,
          routeSegments: ["parallel-routes-no-children", "@bar", "first"],
        },
      ],
      params: {},
      routePath: "/parallel-routes-no-children/first",
      routeSegments: ["parallel-routes-no-children", "first"],
    });

    expect(result.metadata?.title).toBe("first page - @bar");
  });

  it("uses parallel layout title when neither primary page nor slot page set a title", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming-parallel-routes/metadata-streaming-parallel-routes.test.ts
    //
    // Reproduces:
    //   "should still render metadata if children is not rendered in parallel
    //   routes layout"
    //
    // The route has only a `default.tsx` (no `metadata`) at the children slot and
    // the parallel slots render their default fallbacks (no `metadata`). The
    // active title must come from the parallel layout's metadata.
    const rootLayout = {
      metadata: {
        title: "Root",
      },
    };
    const parallelLayout = {
      metadata: {
        title: "parallel-routes-default layout title",
      },
    };
    const defaultPage = {
      // default.tsx with no metadata
    };
    const slotDefault = {
      // @bar/default.tsx with no metadata
    };

    const result = await resolveAppPageHead<Record<string, unknown>>({
      layoutModules: [rootLayout, parallelLayout],
      layoutTreePositions: [0, 1],
      metadataRoutes: [],
      pageModule: defaultPage,
      parallelRoutes: [
        {
          layoutModules: [],
          pageModule: slotDefault,
          routeSegments: ["parallel-routes-default"],
        },
      ],
      params: {},
      routePath: "/parallel-routes-default",
      routeSegments: ["parallel-routes-default"],
    });

    expect(result.metadata?.title).toBe("parallel-routes-default layout title");
  });

  it("bubbles active parallel page metadata errors", async () => {
    await expect(
      resolveAppPageHead<Record<string, unknown>>({
        layoutModules: [],
        layoutTreePositions: [],
        metadataRoutes: [],
        pageModule: null,
        parallelRoutes: [
          {
            pageModule: {
              generateMetadata() {
                throw new Error("slot metadata failed");
              },
            },
            routeSegments: ["dashboard"],
          },
        ],
        params: {},
        routePath: "/dashboard",
        routeSegments: ["dashboard"],
      }),
    ).rejects.toThrow("slot metadata failed");
  });
});
