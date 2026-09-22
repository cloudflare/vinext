import { describe, expect, it, vi } from "vite-plus/test";

describe("Pages Router URL-object navigation", () => {
  function createNavigationWindow({
    pathname,
    search = "",
    page,
    query = {},
  }: {
    pathname: string;
    search?: string;
    page?: string;
    query?: Record<string, string>;
  }) {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const win: any = {
      location: {
        pathname,
        search,
        hash: "",
        href: `http://localhost${pathname}${search}`,
        origin: "http://localhost",
        hostname: "localhost",
      },
      history: { state: null, pushState, replaceState },
      addEventListener() {},
      dispatchEvent() {},
      scrollTo() {},
    };
    if (page !== undefined) {
      win.__NEXT_DATA__ = { page, query, isFallback: false };
    }
    return { win, pushState, replaceState };
  }

  // Next.js prepareUrlAs strips an absolute origin only when it literally
  // prefixes the formatted URL. Credentials precede the host, so the route
  // and implicit display URL remain absolute in history.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/router.ts
  it.each([
    ["auth", { hostname: "localhost", auth: "user:pass" }, undefined],
    ["auth", { hostname: "localhost", auth: "user:pass" }, ""],
    ["host", { host: "user:pass@localhost" }, undefined],
    ["host", { host: "user:pass@localhost" }, ""],
  ] as const)(
    "retains credentials from %s in a same-origin href when as is %s",
    async (_source, authority, as) => {
      const previousWindow = (globalThis as any).window;
      const { win, pushState } = createNavigationWindow({ pathname: "/start" });
      (globalThis as any).window = win;
      try {
        vi.resetModules();
        const Router = (await import("../packages/vinext/src/shims/router.js")).default;
        await expect(
          Router.push({ protocol: "http:", ...authority, pathname: "/target" }, as, {
            shallow: true,
          }),
        ).resolves.toBe(true);
        const absolute = "http://user:pass@localhost/target";
        expect(pushState).toHaveBeenCalledWith(
          expect.objectContaining({ url: absolute, as: absolute }),
          "",
          absolute,
        );
      } finally {
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
        vi.resetModules();
      }
    },
  );

  it.each([{ hostname: "localhost", auth: "user:pass" }, { host: "user:pass@localhost" }])(
    "retains credentials in an explicit same-origin object as history entry (%o)",
    async (authority) => {
      const previousWindow = (globalThis as any).window;
      const { win, pushState } = createNavigationWindow({ pathname: "/start" });
      (globalThis as any).window = win;
      try {
        vi.resetModules();
        const Router = (await import("../packages/vinext/src/shims/router.js")).default;
        const absolute = "http://user:pass@localhost/mask";
        await expect(
          Router.push(
            "/target",
            { protocol: "http:", ...authority, pathname: "/mask" },
            { shallow: true },
          ),
        ).resolves.toBe(true);
        expect(pushState).toHaveBeenCalledWith(
          expect.objectContaining({ url: "/target", as: absolute }),
          "",
          absolute,
        );
      } finally {
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
        vi.resetModules();
      }
    },
  );

  it("query-only UrlObjects preserve the current visible pathname", async () => {
    const previousWindow = (globalThis as any).window;
    const { win, pushState } = createNavigationWindow({
      pathname: "/rewrite-navigation/0",
    });
    (globalThis as any).window = win;

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");

      for (const pathname of [undefined, null, ""]) {
        pushState.mockClear();
        const result = await routerModule.default.push(
          { pathname, query: { id: "1" } },
          undefined,
          { shallow: true },
        );

        expect(result).toBe(true);
        expect(pushState).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "/rewrite-navigation/0?id=1",
            as: "/rewrite-navigation/0?id=1",
          }),
          "",
          "/rewrite-navigation/0?id=1",
        );
      }
    } finally {
      (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  it("interpolates string-valued UrlObject queries on the current dynamic route", async () => {
    const previousWindow = (globalThis as any).window;
    const { win, pushState } = createNavigationWindow({
      pathname: "/posts/1",
      page: "/posts/[id]",
      query: { id: "1" },
    });
    (globalThis as any).window = win;

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");

      await expect(
        routerModule.default.push({ query: "id=2" }, undefined, { shallow: true }),
      ).resolves.toBe(true);

      expect(pushState).toHaveBeenCalledWith(expect.any(Object), "", "/posts/2");
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  // Ported from Next.js: packages/next/src/shared/lib/router/utils/format-url.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/format-url.ts
  it("uses search rather than a shadowed query for dynamic route interpolation", async () => {
    const previousWindow = (globalThis as any).window;
    const { win, pushState } = createNavigationWindow({ pathname: "/start" });
    (globalThis as any).window = win;
    try {
      vi.resetModules();
      const Router = (await import("../packages/vinext/src/shims/router.js")).default;
      await expect(
        Router.push(
          { pathname: "/posts/[id]", query: { id: "wrong" }, search: "id=right" },
          undefined,
          { shallow: true },
        ),
      ).resolves.toBe(true);
      expect(pushState).toHaveBeenCalledWith(
        expect.objectContaining({ as: "/posts/right" }),
        "",
        "/posts/right",
      );
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  it.each([
    ["development", true],
    ["production", false],
  ] as const)("handles an external object-form as in %s", async (nodeEnv, shouldThrow) => {
    const previousWindow = (globalThis as any).window;
    const previousBasePath = process.env.__NEXT_ROUTER_BASEPATH;
    vi.stubEnv("NODE_ENV", nodeEnv);
    process.env.__NEXT_ROUTER_BASEPATH = "/docs";
    const { win } = createNavigationWindow({ pathname: "/docs/start" });
    (globalThis as any).window = win;

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");

      const navigation = routerModule.default.push("/safe", {
        protocol: "https:",
        hostname: "example.com",
        port: "8443",
        auth: "user:pass",
        pathname: "target",
      });

      if (shouldThrow) {
        await expect(navigation).rejects.toThrow(
          'Invalid href: "/docs/safe" and as: "https://user:pass@example.com:8443/target", received relative href and external as',
        );
        expect((globalThis as any).window.location.href).toBe("http://localhost/docs/start");
      } else {
        await expect(navigation).resolves.toBe(false);
        expect((globalThis as any).window.location.href).toBe(
          "https://user:pass@example.com:8443/target",
        );
      }
    } finally {
      vi.unstubAllEnvs();
      if (previousBasePath === undefined) delete process.env.__NEXT_ROUTER_BASEPATH;
      else process.env.__NEXT_ROUTER_BASEPATH = previousBasePath;
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  it.each(["push", "replace"] as const)(
    "warns once for unknown UrlObject keys during %s in development",
    async (method) => {
      const previousWindow = (globalThis as any).window;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("NODE_ENV", "development");
      const { win } = createNavigationWindow({ pathname: "/start" });
      (globalThis as any).window = win;

      try {
        vi.resetModules();
        const Router = (await import("../packages/vinext/src/shims/router.js")).default;
        warn.mockClear();

        await Router[method]({ pathname: "/target", typo: true } as any, undefined, {
          shallow: true,
        });

        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith("Unknown key passed via urlObject into url.format: typo");
      } finally {
        warn.mockRestore();
        vi.unstubAllEnvs();
        vi.resetModules();
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
      }
    },
  );

  it("hard-navigates a same-scheme relative object rejected by basePath", async () => {
    const previousWindow = (globalThis as any).window;
    const previousBasePath = process.env.__NEXT_ROUTER_BASEPATH;
    const pushState = vi.fn();
    let href = "http://localhost/docs/dir/current";
    process.env.__NEXT_ROUTER_BASEPATH = "/docs";
    (globalThis as any).window = {
      location: {
        pathname: "/docs/dir/current",
        search: "",
        hash: "",
        origin: "http://localhost",
        get href() {
          return href;
        },
        set href(value: string) {
          href = new URL(value, href).href;
        },
      },
      history: { state: null, pushState, replaceState() {} },
      addEventListener() {},
      dispatchEvent() {},
      scrollTo() {},
      __NEXT_DATA__: { page: "/dir/current", query: {}, isFallback: false },
    };

    try {
      vi.resetModules();
      const Router = (await import("../packages/vinext/src/shims/router.js")).default;

      await expect(
        Router.push({ protocol: "http:", pathname: "sibling" }, undefined, { shallow: true }),
      ).resolves.toBe(false);
      expect(pushState).not.toHaveBeenCalled();
      expect(href).toBe("http://localhost/docs/dir/sibling");
    } finally {
      if (previousBasePath === undefined) delete process.env.__NEXT_ROUTER_BASEPATH;
      else process.env.__NEXT_ROUTER_BASEPATH = previousBasePath;
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  it.each(["push", "replace"] as const)(
    "hard-navigates an external object href before applying a local as for %s",
    async (method) => {
      const previousWindow = (globalThis as any).window;
      const { win, pushState, replaceState } = createNavigationWindow({ pathname: "/start" });
      (globalThis as any).window = win;

      try {
        vi.resetModules();
        const Router = (await import("../packages/vinext/src/shims/router.js")).default;
        pushState.mockClear();
        replaceState.mockClear();
        const target = {
          protocol: "https:",
          hostname: "example.com",
          pathname: "/route",
        };

        await expect(Router[method](target, "/mask", { shallow: true })).resolves.toBe(false);

        expect((globalThis as any).window.location.href).toBe("https://example.com/route");
        expect(pushState).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
      } finally {
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
        vi.resetModules();
      }
    },
  );

  // Defense in depth: Next.js stripOrigin treats a different authority that
  // starts with the current origin text as local. Do not collapse it to a route.
  it("does not mistake a cross-origin authority prefix for a local route", async () => {
    const previousWindow = (globalThis as any).window;
    const { win, pushState, replaceState } = createNavigationWindow({ pathname: "/start" });
    (globalThis as any).window = win;
    try {
      vi.resetModules();
      const Router = (await import("../packages/vinext/src/shims/router.js")).default;
      pushState.mockClear();
      replaceState.mockClear();

      await expect(
        Router.push(
          { protocol: "http:", hostname: "localhost.evil", pathname: "/target" },
          undefined,
          { shallow: true },
        ),
      ).resolves.toBe(false);

      expect(win.location.href).toBe("http://localhost.evil/target");
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  it.each([
    [
      "href",
      { protocol: "http:", hostname: "localhost", pathname: "/outside" },
      "/mask",
      "/outside",
      "/mask",
      "/docs/mask",
    ],
    [
      "as",
      "/target",
      { protocol: "http:", hostname: "localhost", pathname: "/outside" },
      "/target",
      "/outside",
      "/docs/outside",
    ],
  ])(
    "keeps same-origin object %s values outside basePath in the router",
    async (_label, url, as, stateUrl, stateAs, browserUrl) => {
      const previousWindow = (globalThis as any).window;
      const previousBasePath = process.env.__NEXT_ROUTER_BASEPATH;
      process.env.__NEXT_ROUTER_BASEPATH = "/docs";
      const { win, pushState } = createNavigationWindow({ pathname: "/docs/start" });
      (globalThis as any).window = win;

      try {
        vi.resetModules();
        const Router = (await import("../packages/vinext/src/shims/router.js")).default;

        await expect(Router.push(url, as, { shallow: true })).resolves.toBe(true);
        expect(pushState).toHaveBeenCalledWith(
          expect.objectContaining({ url: stateUrl, as: stateAs }),
          "",
          browserUrl,
        );
      } finally {
        if (previousBasePath === undefined) delete process.env.__NEXT_ROUTER_BASEPATH;
        else process.env.__NEXT_ROUTER_BASEPATH = previousBasePath;
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
        vi.resetModules();
      }
    },
  );

  it("resolves an explicit query-only mask from the current dynamic route", async () => {
    const previousWindow = (globalThis as any).window;
    const { win, pushState } = createNavigationWindow({
      pathname: "/posts/1",
      page: "/posts/[id]",
      query: { id: "1" },
    });
    (globalThis as any).window = win;

    try {
      vi.resetModules();
      const Router = (await import("../packages/vinext/src/shims/router.js")).default;

      await Router.push("/about", { query: { id: "2" } }, { shallow: true });
      expect(pushState).toHaveBeenCalledWith(
        expect.objectContaining({ url: "/about", as: "/posts/[id]?id=2" }),
        "",
        "/posts/[id]?id=2",
      );
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  it.each([
    [{ pathname: "/literal?mark#hash" }, "/literal%3Fmark%23hash", "/literal%3Fmark%23hash"],
    [
      { pathname: "/foo/../bar", query: { x: "1" }, hash: "hash" },
      "/bar?x=1#hash",
      "/bar?x=1#hash",
    ],
    [
      "/target",
      "/bar?x=1#hash",
      "/bar?x=1#hash",
      { pathname: "/foo/../bar", query: { x: "1" }, hash: "hash" },
      "/target",
    ],
    [{ search: "flag" }, "/rewrite-navigation/0?flag", "/rewrite-navigation/0?flag"],
    [{ search: "q=a b" }, "/rewrite-navigation/0?q=a%20b", "/rewrite-navigation/0?q=a%20b"],
    [{ search: "q=a%20b" }, "/rewrite-navigation/0?q=a%20b", "/rewrite-navigation/0?q=a%20b"],
    [{ search: "q=a#b" }, "/rewrite-navigation/0?q=a%23b", "/rewrite-navigation/0?q=a%23b"],
    [{ search: "q=a#b#c" }, "/rewrite-navigation/0?q=a%23b#c", "/rewrite-navigation/0?q=a%23b#c"],
    [{ search: "?" }, "/rewrite-navigation/0?", "/rewrite-navigation/0?"],
    [
      { query: { id: "ignored" }, search: "id=3" },
      "/rewrite-navigation/0?id=3",
      "/rewrite-navigation/0?id=3",
    ],
    [
      { search: "q=a%20b", hash: "result" },
      "/rewrite-navigation/0?q=a%20b#result",
      "/rewrite-navigation/0?q=a%20b#result",
    ],
    [
      { search: "q=a#b", hash: "result" },
      "/rewrite-navigation/0?q=a%23b#result",
      "/rewrite-navigation/0?q=a%23b#result",
    ],
    [
      { query: { id: "ignored" }, search: "?id=3", hash: "#result" },
      "/rewrite-navigation/0?id=3#result",
      "/rewrite-navigation/0?id=3#result",
    ],
    [
      { hash: "section" },
      "/rewrite-navigation/0?existing=1#section",
      "/rewrite-navigation/0?existing=1#section",
    ],
    [
      { pathname: "", hash: "section" },
      "/rewrite-navigation/0?existing=1#section",
      "/rewrite-navigation/0?existing=1#section",
    ],
  ])(
    "formats Pages Router UrlObjects with Next.js semantics: %j",
    async (...[url, expected, stateAs, as, stateUrl = stateAs]) => {
      const previousWindow = (globalThis as any).window;
      const previousDocument = (globalThis as any).document;
      const { win, pushState } = createNavigationWindow({
        pathname: "/rewrite-navigation/0",
        search: "?existing=1",
        page: "/rewrite-navigation/[id]/destination",
        query: { id: "0" },
      });
      (globalThis as any).window = win;
      (globalThis as any).document = {
        getElementById: vi.fn(() => null),
        getElementsByName: vi.fn(() => []),
      };

      try {
        vi.resetModules();
        const routerModule = await import("../packages/vinext/src/shims/router.js");
        await routerModule.default.push(url, as, { shallow: true });

        expect(pushState).toHaveBeenCalledWith(
          expect.objectContaining({ url: stateUrl, as: stateAs }),
          "",
          expected,
        );
      } finally {
        (globalThis as any).window = previousWindow;
        if (previousDocument === undefined) delete (globalThis as any).document;
        else (globalThis as any).document = previousDocument;
        vi.resetModules();
      }
    },
  );

  it.each([
    [{ protocol: "http:", pathname: "sibling" }, "/dir/sibling"],
    [{ protocol: "http:", query: { x: "1" } }, "/dir/current?x=1"],
    [{ protocol: "http:", hash: "section" }, "/dir/current#section"],
    [{ protocol: "HTTP:", hostname: "localhost", pathname: "/target" }, "/dir/localhost/target"],
  ])(
    "resolves same-scheme protocol objects relative to the router pathname",
    async (url, expected) => {
      const previousWindow = (globalThis as any).window;
      const { win, pushState } = createNavigationWindow({
        pathname: "/dir/current",
        page: "/dir/current",
      });
      (globalThis as any).window = win;

      try {
        vi.resetModules();
        const { default: Router } = await import("../packages/vinext/src/shims/router.js");

        await expect(Router.push(url, undefined, { shallow: true, scroll: false })).resolves.toBe(
          true,
        );
        expect(pushState).toHaveBeenCalledWith(
          expect.objectContaining({ url: expected, as: expected }),
          "",
          expected,
        );
      } finally {
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
        vi.resetModules();
      }
    },
  );

  it.each(["push", "replace"] as const)(
    "preserves a bare trailing question mark in router.asPath after %s",
    async (method) => {
      const previousWindow = (globalThis as any).window;
      const win: any = {
        location: {
          pathname: "/rewrite-navigation/0",
          search: "",
          hash: "",
          href: "http://localhost/rewrite-navigation/0",
          origin: "http://localhost",
        },
        history: {
          state: null as unknown,
          pushState(state: unknown, _title: string, url: string) {
            this.state = state;
            const nextUrl = new URL(url, win.location.href);
            win.location.pathname = nextUrl.pathname;
            win.location.search = nextUrl.search;
            win.location.hash = nextUrl.hash;
            win.location.href = nextUrl.href;
          },
          replaceState(state: unknown, _title: string, url?: string) {
            this.state = state;
            if (url === undefined) return;
            const nextUrl = new URL(url, win.location.href);
            win.location.pathname = nextUrl.pathname;
            win.location.search = nextUrl.search;
            win.location.hash = nextUrl.hash;
            win.location.href = nextUrl.href;
          },
        },
        addEventListener() {},
        dispatchEvent() {},
        scrollTo() {},
        scrollX: 0,
        scrollY: 0,
        __NEXT_DATA__: {
          page: "/rewrite-navigation/[id]/destination",
          query: { id: "0" },
          isFallback: false,
        },
      };
      (globalThis as any).window = win;

      try {
        vi.resetModules();
        const routerModule = await import("../packages/vinext/src/shims/router.js");
        await routerModule.default[method]({ search: "?" }, undefined, { shallow: true });

        expect(win.location.search).toBe("");
        expect(win.history.state.as).toBe("/rewrite-navigation/0?");
        expect(routerModule.default.asPath).toBe("/rewrite-navigation/0?");
      } finally {
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
        vi.resetModules();
      }
    },
  );

  it.each([
    ["/", "", "/#section"],
    ["/posts", "?tab=1", "/posts?tab=1#section"],
  ])(
    "preserves the visible path and search in router.asPath after hash-only navigation from %s%s",
    async (pathname, search, expectedAsPath) => {
      const previousWindow = (globalThis as any).window;
      const win: any = {
        location: {
          pathname,
          search,
          hash: "",
          href: `http://localhost${pathname}${search}`,
          origin: "http://localhost",
        },
        history: {
          state: null as unknown,
          pushState(state: unknown, _title: string, url: string) {
            this.state = state;
            const nextUrl = new URL(url, win.location.href);
            win.location.pathname = nextUrl.pathname;
            win.location.search = nextUrl.search;
            win.location.hash = nextUrl.hash;
            win.location.href = nextUrl.href;
          },
          replaceState() {},
        },
        addEventListener() {},
        dispatchEvent() {},
        scrollTo() {},
        scrollX: 0,
        scrollY: 0,
        __NEXT_DATA__: { page: pathname, query: {}, isFallback: false },
      };
      (globalThis as any).window = win;
      (globalThis as any).document = {
        getElementById: vi.fn(() => null),
        getElementsByName: vi.fn(() => []),
      };

      try {
        vi.resetModules();
        const routerModule = await import("../packages/vinext/src/shims/router.js");
        await routerModule.default.push("#section");

        expect(win.history.state).toMatchObject({ url: expectedAsPath, as: expectedAsPath });
        expect(routerModule.default.asPath).toBe(expectedAsPath);
      } finally {
        if (previousWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = previousWindow;
        delete (globalThis as any).document;
        vi.resetModules();
      }
    },
  );

  it.each([
    [
      "query-only href",
      { query: { id: "1" } },
      undefined,
      "nl",
      "/nl/rewrite-navigation/0?id=1",
      "/docs/nl/rewrite-navigation/0?id=1",
    ],
    [
      "explicit query-only as",
      "/target",
      { query: { tab: "1" } },
      "en",
      "/rewrite-navigation/0?tab=1",
      "/docs/rewrite-navigation/0?tab=1",
    ],
    [
      "explicit hash-only as",
      "/target",
      { hash: "section" },
      "en",
      "/rewrite-navigation/0#section",
      "/docs/rewrite-navigation/0#section",
    ],
    [
      "query-only href with an empty as",
      { query: { tab: "1" } },
      "",
      "en",
      "/rewrite-navigation/0?tab=1",
      "/docs/rewrite-navigation/0?tab=1",
    ],
  ])("replaces the current locale for a %s", async (_case, url, as, locale, stateAs, browserAs) => {
    const previousWindow = (globalThis as any).window;
    const previousBasePath = process.env.__NEXT_ROUTER_BASEPATH;
    const pushState = vi.fn();
    process.env.__NEXT_ROUTER_BASEPATH = "/docs";
    const win: any = {
      location: {
        pathname: "/docs/fr/rewrite-navigation/0",
        search: "",
        hash: "",
        href: "http://localhost/docs/fr/rewrite-navigation/0",
        origin: "http://localhost",
        hostname: "localhost",
      },
      history: { state: null, pushState, replaceState() {} },
      addEventListener() {},
      dispatchEvent() {},
      scrollTo() {},
      __VINEXT_LOCALE__: "fr",
      __VINEXT_LOCALES__: ["en", "fr", "nl"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    };
    (globalThis as any).window = win;

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      await routerModule.default.push(url, as, {
        locale,
        shallow: true,
        scroll: false,
      });

      expect(pushState).toHaveBeenCalledWith(
        expect.objectContaining({ as: stateAs }),
        "",
        browserAs,
      );
    } finally {
      if (previousBasePath === undefined) delete process.env.__NEXT_ROUTER_BASEPATH;
      else process.env.__NEXT_ROUTER_BASEPATH = previousBasePath;
      (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });

  it("query-only replace with locale false removes the current locale under basePath", async () => {
    const previousWindow = (globalThis as any).window;
    const previousBasePath = process.env.__NEXT_ROUTER_BASEPATH;
    const replaceState = vi.fn();
    process.env.__NEXT_ROUTER_BASEPATH = "/docs";
    const win: any = {
      location: {
        pathname: "/docs/fr/rewrite-navigation/0",
        search: "",
        hash: "",
        href: "http://localhost/docs/fr/rewrite-navigation/0",
        origin: "http://localhost",
        hostname: "localhost",
      },
      history: { state: null, pushState() {}, replaceState },
      addEventListener() {},
      dispatchEvent() {},
      scrollTo() {},
      __VINEXT_LOCALE__: "fr",
      __VINEXT_LOCALES__: ["en", "fr"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    };
    (globalThis as any).window = win;

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      await routerModule.default.replace({ search: "id=2" }, undefined, {
        locale: false,
        shallow: true,
      });

      expect(replaceState).toHaveBeenCalledWith(
        expect.objectContaining({ as: "/rewrite-navigation/0?id=2" }),
        "",
        "/docs/rewrite-navigation/0?id=2",
      );
    } finally {
      if (previousBasePath === undefined) delete process.env.__NEXT_ROUTER_BASEPATH;
      else process.env.__NEXT_ROUTER_BASEPATH = previousBasePath;
      (globalThis as any).window = previousWindow;
      vi.resetModules();
    }
  });
});
