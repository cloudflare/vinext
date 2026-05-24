import { describe, expect, it } from "vite-plus/test";
import {
  collectAppPageSearchParams,
  resolveAppPageHead,
} from "../packages/vinext/src/server/app-page-head.js";
import type { AppPageParams } from "../packages/vinext/src/server/app-page-boundary.js";

describe("app page head resolution", () => {
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
      initialScale: 1,
      width: "device-width",
    });
    expect(result.pageSearchParams).toEqual({ tag: ["next", "vinext"] });
    expect(result.hasSearchParams).toBe(true);
    expect(layoutSearchParamsSeen).toEqual([undefined]);
    expect(layoutParamsSeen).toEqual([{}]);
    expect(pageParentImages).toEqual(["/root-og.png", "/nested-og.png"]);
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

  it("keeps primary page title handling independent from active parallel route metadata", async () => {
    const rootLayout = {
      metadata: {
        title: { default: "Root", template: "%s | Root" },
      },
    };
    const page = {
      metadata: {
        description: "Primary page",
        title: { default: "Page", template: "%s | Page" },
      },
    };
    const slotLayout = {
      metadata: {
        title: { default: "Slot", template: "%s | Slot" },
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
      layoutModules: [rootLayout],
      layoutTreePositions: [0],
      metadataRoutes: [],
      pageModule: page,
      parallelRoutes: [
        {
          layoutModules: [slotLayout],
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
      title: "Page | Root",
      twitter: {
        card: "summary",
        description: "Primary page",
        title: "Slot OG title",
      },
    });
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
