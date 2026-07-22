import { describe, expect, it } from "vite-plus/test";
import {
  type DevAppInitialPropsContext,
  loadDevAppInitialProps,
} from "../packages/vinext/src/server/pages-get-initial-props.js";

/**
 * Real inputs, no module mocks: loadDevAppInitialProps takes the App component,
 * a plain req/res, and an AppTree builder as parameters — its actual boundary.
 * Tests drive it with genuine getInitialProps functions and observe the
 * returned decision.
 */
function createContext(
  overrides: Partial<DevAppInitialPropsContext> = {},
): DevAppInitialPropsContext {
  return {
    appComponent: function App() {
      return null;
    },
    appTree: (appTreeProps) => ({ tree: appTreeProps }),
    component: function Page() {
      return null;
    },
    req: { url: "/posts/post" },
    res: { headersSent: false, writableEnded: false },
    pathname: "/posts/[slug]",
    query: { slug: "post" },
    asPath: "/posts/post",
    locale: "en",
    locales: ["en", "fr"],
    defaultLocale: "en",
    ...overrides,
  };
}

describe("loadDevAppInitialProps", () => {
  it("skips when the App has no getInitialProps", async () => {
    const result = await loadDevAppInitialProps(createContext());
    expect(result).toEqual({ kind: "skip" });
  });

  it("returns App and page-level props on a render", async () => {
    const appComponent = Object.assign(
      function App() {
        return null;
      },
      {
        getInitialProps() {
          return { appProp: "from-app", pageProps: { pageProp: "from-app-page" } };
        },
      },
    );

    const result = await loadDevAppInitialProps(createContext({ appComponent }));

    expect(result).toEqual({
      kind: "render",
      pageProps: { pageProp: "from-app-page" },
      renderProps: { appProp: "from-app", pageProps: { pageProp: "from-app-page" } },
    });
  });

  it("preserves missing pageProps in the App envelope", async () => {
    const appComponent = Object.assign(
      function App() {
        return null;
      },
      {
        // No pageProps key at all.
        getInitialProps() {
          return { appProp: "from-app" };
        },
      },
    );

    const result = await loadDevAppInitialProps(createContext({ appComponent }));

    expect(result).toEqual({
      kind: "render",
      pageProps: {},
      renderProps: { appProp: "from-app" },
    });
  });

  it("reports response-sent when getInitialProps ends the response itself", async () => {
    const res = { headersSent: false, writableEnded: false };
    const appComponent = Object.assign(
      function App() {
        return null;
      },
      {
        getInitialProps() {
          // Simulate App.getInitialProps writing the response directly.
          res.headersSent = true;
          return {};
        },
      },
    );

    const result = await loadDevAppInitialProps(createContext({ appComponent, res }));

    expect(result).toEqual({ kind: "response-sent" });
  });

  it("passes router and ctx fields plus an AppTree builder to getInitialProps", async () => {
    let received: Record<string, unknown> | undefined;
    const appComponent = Object.assign(
      function App() {
        return null;
      },
      {
        async getInitialProps(context: Record<string, unknown>) {
          received = context;
          const appTree = context.AppTree as (p: Record<string, unknown>) => unknown;
          // Exercise the injected AppTree builder.
          const tree = appTree({ pageProps: { x: 1 } });
          return { tree, pageProps: {} };
        },
      },
    );

    await loadDevAppInitialProps(createContext({ appComponent }));

    expect(received).toBeDefined();
    expect(received).toMatchObject({
      Component: expect.any(Function),
      AppTree: expect.any(Function),
      router: {
        route: "/posts/[slug]",
        pathname: "/posts/[slug]",
        query: { slug: "post" },
        asPath: "/posts/post",
      },
      ctx: {
        pathname: "/posts/[slug]",
        query: { slug: "post" },
        asPath: "/posts/post",
        locale: "en",
        locales: ["en", "fr"],
        defaultLocale: "en",
      },
    });
  });

  // Next.js passes its ServerRouter to App.getInitialProps. Its `route` is the
  // route pattern, not the concrete URL: packages/next/src/server/render.tsx.
  it("provides the route pattern to App.getInitialProps router consumers", async () => {
    const appComponent = Object.assign(
      function App() {
        return null;
      },
      {
        getInitialProps({ router }: { router: { route: string } }) {
          return {
            pageProps: { routeTag: router.route.replaceAll("/", "_") },
          };
        },
      },
    );

    const result = await loadDevAppInitialProps(createContext({ appComponent }));

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { routeTag: "_posts_[slug]" },
    });
  });
});
