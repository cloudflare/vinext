import { describe, expect, it, vi } from "vite-plus/test";
import {
  collectAppPageSearchParams,
  prepareAppPageHead,
  resolveActiveParallelRouteHeadInputs,
  resolveAppPageHead,
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
      await expect(prepare(key, true).routeErrors).rejects.toBe(notFoundError);
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
    await prepared.routeErrors;
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

  it("keeps a hidden slot intercept's errors out of the head but in the route's errors", async () => {
    // The source route's head stays visible, yet the intercept's
    // generateMetadata() and generateViewport() still run, and their errors
    // still reach the route's outlet.
    const metadataError = new Error("intercept metadata");
    const viewportError = new Error("intercept viewport");
    const prepare = (pageModule: Record<string, unknown>) =>
      prepareAppPageHead<Record<string, unknown>>({
        hiddenParallelRoutes: [
          { parallelRouteIndex: 0, route: { pageModule }, sharedLayoutCount: 0 },
        ],
        layoutModules: [],
        metadataRoutes: [],
        pageModule: { metadata: { title: "Feed page" } },
        parallelRoutes: [{ pageModule: { metadata: { description: "Feed slot" } } }],
        params: {},
        routePath: "/",
        routeSegments: [],
      });

    const fromMetadata = prepare({
      generateMetadata() {
        throw metadataError;
      },
    });
    await expect(fromMetadata.metadata).resolves.toMatchObject({ title: "Feed page" });
    await expect(fromMetadata.routeErrors).rejects.toBe(metadataError);

    const fromViewport = prepare({
      generateViewport() {
        throw viewportError;
      },
    });
    await expect(fromViewport.viewport).resolves.toBeDefined();
    await expect(fromViewport.routeErrors).rejects.toBe(viewportError);
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
