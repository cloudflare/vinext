import { describe, expect, it } from "vite-plus/test";
import {
  buildPagesReadinessNextData,
  computePagesNextDataQuery,
} from "../packages/vinext/src/server/pages-readiness.js";
import App from "../packages/vinext/src/shims/app.js";
import { getPagesNavigationIsReadyFromSerializedState } from "../packages/vinext/src/shims/router.js";

describe("buildPagesReadinessNextData", () => {
  // Ported from Next.js: test/e2e/auto-export/auto-export.test.ts
  // https://github.com/vercel/next.js/blob/v16.3.0-canary.80/test/e2e/auto-export/auto-export.test.ts
  it("marks automatically exported pages with nextExport", () => {
    expect(
      buildPagesReadinessNextData({
        pageModule: { default: () => null },
        appComponent: null,
        hasRewrites: false,
      }),
    ).toMatchObject({
      autoExport: true,
      nextExport: true,
    });
  });

  it("omits nextExport for data-driven pages", () => {
    expect(
      buildPagesReadinessNextData({
        pageModule: {
          default: () => null,
          getServerSideProps: async () => ({ props: {} }),
        },
        appComponent: null,
        hasRewrites: false,
      }).nextExport,
    ).toBeUndefined();
  });

  // Next.js classifies a custom _app as data-driven only when it overrides the
  // built-in implementation. A subclass that inherits both static functions
  // remains automatically optimized.
  // Ported from Next.js: packages/next/src/server/render.tsx
  // https://github.com/vercel/next.js/blob/v16.3.0-canary.80/packages/next/src/server/render.tsx
  it("keeps an _app inheriting the default getInitialProps automatically optimized", () => {
    class InheritedApp extends App {}

    expect(InheritedApp.getInitialProps).toBe(InheritedApp.origGetInitialProps);

    const nextData = buildPagesReadinessNextData({
      pageModule: { default: () => null },
      appComponent: InheritedApp,
      hasRewrites: false,
    });

    expect(nextData).toMatchObject({
      appGip: false,
      autoExport: true,
      nextExport: true,
    });

    // The auto-export markers keep the dynamic route pre-ready so the client
    // can replace the route-pattern query/asPath with the live URL state on
    // mount, matching Next.js's auto-export router transition.
    expect(
      getPagesNavigationIsReadyFromSerializedState("/[post]", "", {
        props: {},
        page: "/[post]",
        query: {},
        ...nextData,
      }),
    ).toBe(false);
    expect(
      getPagesNavigationIsReadyFromSerializedState("/zeit/[slug]", "?from=query", {
        props: {},
        page: "/zeit/[slug]",
        query: {},
        ...nextData,
      }),
    ).toBe(false);
  });

  it("marks an _app override as appGip", () => {
    class CustomApp extends App {
      static override async getInitialProps() {
        return { pageProps: {} };
      }
    }

    expect(
      buildPagesReadinessNextData({
        pageModule: { default: () => null },
        appComponent: CustomApp,
        hasRewrites: false,
      }),
    ).toMatchObject({
      appGip: true,
      autoExport: false,
      nextExport: undefined,
    });
  });
});

describe("computePagesNextDataQuery", () => {
  const query = { id: "42", q: "foo" };
  const params = { id: "42" };

  it("returns the full merged query for getServerSideProps pages (#1970)", () => {
    expect(
      computePagesNextDataQuery({
        query,
        params,
        isFallback: false,
        autoExport: false,
        gsp: undefined,
      }),
    ).toEqual({ id: "42", q: "foo" });
  });

  it("returns the full merged query for getInitialProps pages", () => {
    // gip/appGip pages classify as non-autoExport, non-gsp → full query.
    expect(
      computePagesNextDataQuery({
        query,
        params,
        isFallback: false,
        autoExport: false,
        gsp: undefined,
      }),
    ).toEqual({ id: "42", q: "foo" });
  });

  it("drops the querystring for getStaticProps pages (route params only)", () => {
    expect(
      computePagesNextDataQuery({
        query,
        params,
        isFallback: false,
        autoExport: false,
        gsp: true,
      }),
    ).toEqual({ id: "42" });
  });

  it("resets to {} for autoExport pages", () => {
    expect(
      computePagesNextDataQuery({
        query,
        params,
        isFallback: false,
        autoExport: true,
        gsp: undefined,
      }),
    ).toEqual({});
  });

  it("resets to {} for getStaticPaths fallback shell renders", () => {
    expect(
      computePagesNextDataQuery({
        query,
        params,
        isFallback: true,
        autoExport: false,
        gsp: undefined,
      }),
    ).toEqual({});
  });

  it("isFallback overrides gsp (a fallback shell of a gsp page resets to {})", () => {
    expect(
      computePagesNextDataQuery({
        query,
        params,
        isFallback: true,
        autoExport: false,
        gsp: true,
      }),
    ).toEqual({});
  });
});
