import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type FakeWindow = typeof globalThis & {
  scrollX: number;
  scrollY: number;
  history: {
    state: unknown;
    scrollRestoration: string;
    replaceState: ReturnType<typeof vi.fn>;
    pushState: ReturnType<typeof vi.fn>;
    back: ReturnType<typeof vi.fn>;
    forward: ReturnType<typeof vi.fn>;
  };
  location: {
    href: string;
    origin: string;
    hostname: string;
    pathname: string;
    search: string;
    hash: string;
    assign: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
  sessionStorage: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
  };
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  scrollTo: ReturnType<typeof vi.fn>;
  next?: { router?: unknown };
  __NEXT_DATA__?: { page: string; query: Record<string, string>; isFallback: boolean };
  __VINEXT_LOCALE__?: string;
  __VINEXT_LOCALES__?: string[];
  __VINEXT_DEFAULT_LOCALE__?: string;
};

function installFakeWindow() {
  const sessionStore = new Map<string, string>();
  const listeners = new Map<string, EventListener[]>();
  const location = {
    href: "http://localhost/0",
    origin: "http://localhost",
    hostname: "localhost",
    pathname: "/0",
    search: "",
    hash: "",
    assign: vi.fn((href: string) => setUrl(href)),
    replace: vi.fn((href: string) => setUrl(href)),
    reload: vi.fn(),
  };

  function setUrl(url: string | URL): void {
    const next = new URL(String(url), location.href);
    location.href = next.href;
    location.origin = next.origin;
    location.hostname = next.hostname;
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  }

  const fakeWindow = {
    location,
    scrollX: 0,
    scrollY: 0,
    history: {
      state: null,
      scrollRestoration: "auto",
      replaceState: vi.fn((state: unknown, _title: string, url?: string | URL | null) => {
        fakeWindow.history.state = state;
        if (url != null) setUrl(url);
      }),
      pushState: vi.fn((state: unknown, _title: string, url?: string | URL | null) => {
        fakeWindow.history.state = state;
        if (url != null) setUrl(url);
      }),
      back: vi.fn(),
      forward: vi.fn(),
    },
    sessionStorage: {
      getItem: vi.fn((key: string) => sessionStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        sessionStore.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        sessionStore.delete(key);
      }),
    },
    addEventListener: vi.fn((event: string, listener: EventListener) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    scrollTo: vi.fn((x: number, y: number) => {
      fakeWindow.scrollX = x;
      fakeWindow.scrollY = y;
    }),
    __NEXT_DATA__: {
      page: "/[id]",
      query: { id: "0" },
      isFallback: false,
    },
  } as unknown as FakeWindow;

  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal(
    "CustomEvent",
    class CustomEvent extends Event {
      detail: unknown;
      constructor(type: string, init?: CustomEventInit) {
        super(type);
        this.detail = init?.detail;
      }
    },
  );

  return { window: fakeWindow, sessionStore, listeners, setUrl };
}

describe("Pages Router manual scroll restoration", () => {
  let previousScrollRestoration: string | undefined;

  beforeEach(() => {
    previousScrollRestoration = process.env.__NEXT_SCROLL_RESTORATION;
    process.env.__NEXT_SCROLL_RESTORATION = "true";
  });

  afterEach(() => {
    if (previousScrollRestoration === undefined) {
      delete process.env.__NEXT_SCROLL_RESTORATION;
    } else {
      process.env.__NEXT_SCROLL_RESTORATION = previousScrollRestoration;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Ported from Next.js: test/e2e/reload-scroll-backforward-restoration/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/reload-scroll-backforward-restoration/index.test.ts
  it("sets browser history scrollRestoration to manual when enabled", async () => {
    const { window } = installFakeWindow();

    await import("../packages/vinext/src/shims/router.js" + "?scroll-restoration-enabled");

    expect(window.history.scrollRestoration).toBe("manual");
    expect(window.history.replaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        __N: true,
        key: expect.any(String),
        url: "/0",
        as: "/0",
      }),
      "",
    );
  });

  it("saves the current history entry scroll position before pushState", async () => {
    const { window, sessionStore } = installFakeWindow();
    const router = await import(
      "../packages/vinext/src/shims/router.js" + "?scroll-restoration-push"
    );
    const initialState = window.history.state as { key: string };

    window.scrollX = 321;
    window.scrollY = 654;
    await router.default.push("/1", undefined, { shallow: true });

    expect(sessionStore.get(`__next_scroll_${initialState.key}`)).toBe(
      JSON.stringify({ x: 321, y: 654 }),
    );
    expect(window.history.pushState).toHaveBeenCalledWith(
      expect.objectContaining({
        __N: true,
        key: expect.not.stringMatching(initialState.key),
        url: "/1",
        as: "/1",
      }),
      "",
      "/1",
    );
  });

  it("does not ignore the first real popstate after a refresh", async () => {
    const { listeners, setUrl } = installFakeWindow();
    setUrl("/1");
    const router = await import(
      "../packages/vinext/src/shims/router.js" + "?scroll-restoration-popstate"
    );
    const beforePopState = vi.fn(() => false);
    router.default.beforePopState(beforePopState);

    setUrl("/0");
    listeners.get("popstate")?.[0]?.({
      state: {
        __N: true,
        url: "/0",
        as: "/0",
        options: {},
        key: "target-key",
      },
    } as PopStateEvent);

    expect(beforePopState).toHaveBeenCalledWith({
      url: "/0",
      as: "/0",
      options: { shallow: false },
    });
  });
});
