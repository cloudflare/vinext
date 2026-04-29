import { describe, expect, it } from "vite-plus/test";
import {
  collectAppPageSearchParams,
  resolveAppPageHead,
} from "../packages/vinext/src/server/app-page-head.js";
import type { AppPageParams } from "../packages/vinext/src/server/app-page-boundary.js";

describe("app page head helpers", () => {
  it("collects repeated search params into a null-prototype object", () => {
    const { hasSearchParams, searchParamsObject } = collectAppPageSearchParams(
      new URLSearchParams("__proto__=safe&tag=a&tag=b"),
    );

    expect(hasSearchParams).toBe(true);
    expect(Object.getPrototypeOf(searchParamsObject)).toBe(null);
    expect(searchParamsObject["__proto__"]).toBe("safe");
    expect(searchParamsObject.tag).toEqual(["a", "b"]);
  });

  it("passes scoped params to layout metadata and full params/searchParams to page metadata", async () => {
    // Ported from Next.js: test/e2e/app-dir/layout-params/layout-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/layout-params/layout-params.test.ts
    // Reference: packages/next/src/lib/metadata/resolve-metadata.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
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
      pageModule: page,
      params: { category: "books", id: "dune" },
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
});
