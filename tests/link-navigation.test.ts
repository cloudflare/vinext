import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import ReactDOMServer from "react-dom/server";
import type { ElementType, ReactNode } from "react";
import {
  getLinkPrefetchDecision,
  getLinkPrefetchHref,
  type LinkPrefetchIntent,
  type LinkPrefetchDecision,
} from "../packages/vinext/src/shims/link-prefetch.js";
import type { VinextLinkPrefetchRoute } from "../packages/vinext/src/client/vinext-next-data.js";

type CapturedEffect = () => void | (() => void);

type CapturedClickEvent = {
  altKey?: boolean;
  button: number;
  ctrlKey?: boolean;
  currentTarget: { target: string };
  defaultPrevented: boolean;
  metaKey?: boolean;
  preventDefault(): void;
  shiftKey?: boolean;
};

type CapturedIntentEvent = Pick<MouseEvent, "currentTarget">;

type CapturedAnchorProps = {
  onClick?: (event: CapturedClickEvent) => void | Promise<void>;
  onMouseEnter?: (event: CapturedIntentEvent) => void;
  onTouchStart?: (event: CapturedIntentEvent) => void;
  ref?: (node: HTMLAnchorElement | null) => void;
};

const linkPrefetchRoutes = [
  { patternParts: ["viewport-prefetch-target"], isDynamic: false },
  { patternParts: ["intent-prefetch-target"], isDynamic: false },
  { patternParts: ["touch-prefetch-target"], isDynamic: false },
  { patternParts: ["same-origin-intent-prefetch-target"], isDynamic: false },
  { patternParts: ["blog", ":slug"], isDynamic: true },
] satisfies VinextLinkPrefetchRoute[];

type MockReactAnchorCaptureOptions = {
  captureAnchor(type: unknown, props: unknown): void;
  captureEffect?: (effect: CapturedEffect) => void;
  startTransition?: (callback: () => void) => void;
};

// This is a tactical escape hatch for Link only. It intercepts React and JSX
// runtime output because the current E2E setup cannot honestly reach the
// production-only Link prefetch path. It mocks useEffect synchronously and
// captures element creation before reconciliation, so it cannot test commit
// scheduling, cleanup, re-renders, or conditional effect execution. Do not
// reuse it as a component harness.
function mockReactAnchorCaptureForLinkOnly_DO_NOT_REUSE(
  options: MockReactAnchorCaptureOptions,
): void {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    const createElement = ((
      type: ElementType,
      props: Record<string, unknown> | null,
      ...children: ReactNode[]
    ) => {
      options.captureAnchor(type, props);
      return actual.createElement(type, props, ...children);
    }) as typeof actual.createElement;

    const mockDefault = { ...actual, createElement };
    if (options.captureEffect !== undefined) {
      const useEffect = (effect: CapturedEffect) => {
        options.captureEffect?.(effect);
      };
      return {
        ...actual,
        createElement,
        useEffect,
        default: { ...mockDefault, useEffect },
      };
    }

    if (options.startTransition !== undefined) {
      return {
        ...actual,
        createElement,
        startTransition: options.startTransition,
        default: { ...mockDefault, startTransition: options.startTransition },
      };
    }

    return {
      ...actual,
      createElement,
      default: mockDefault,
    };
  });

  vi.doMock("react/jsx-runtime", async () => {
    const actual = await vi.importActual<typeof import("react/jsx-runtime")>("react/jsx-runtime");
    return {
      ...actual,
      jsx(type: ElementType, props: Record<string, unknown>, key?: string) {
        options.captureAnchor(type, props);
        return actual.jsx(type, props, key);
      },
      jsxs(type: ElementType, props: Record<string, unknown>, key?: string) {
        options.captureAnchor(type, props);
        return actual.jsxs(type, props, key);
      },
    };
  });

  vi.doMock("react/jsx-dev-runtime", async () => {
    const actual =
      await vi.importActual<typeof import("react/jsx-dev-runtime")>("react/jsx-dev-runtime");
    return {
      ...actual,
      jsxDEV(
        type: ElementType,
        props: Record<string, unknown>,
        key?: string,
        isStaticChildren?: boolean,
        source?: Parameters<typeof actual.jsxDEV>[4],
        self?: Parameters<typeof actual.jsxDEV>[5],
      ) {
        options.captureAnchor(type, props);
        return actual.jsxDEV(type, props, key, isStaticChildren ?? false, source, self);
      },
    };
  });
}

async function flushPrefetchTasks(): Promise<void> {
  // requestIdleCallback is mocked as sync, then prefetchUrl enters an async
  // IIFE with one awaited createRscRequestUrl call. These ticks drain the
  // current chain; update this helper if the async depth grows.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Link prefetch pure decisions", () => {
  it("decides whether Link should prefetch and with which priority", () => {
    const cases = [
      {
        name: "dev + viewport",
        input: {
          nodeEnv: "development",
          prefetch: undefined,
          isDangerous: false,
          intent: "viewport",
        },
        expected: { shouldPrefetch: false },
      },
      {
        name: "dev + intent",
        input: {
          nodeEnv: "development",
          prefetch: undefined,
          isDangerous: false,
          intent: "intent",
        },
        expected: { shouldPrefetch: false },
      },
      {
        name: "prod + viewport",
        input: {
          nodeEnv: "production",
          prefetch: undefined,
          isDangerous: false,
          intent: "viewport",
        },
        expected: { shouldPrefetch: true, priority: "low" },
      },
      {
        name: "prod + intent",
        input: { nodeEnv: "production", prefetch: undefined, isDangerous: false, intent: "intent" },
        expected: { shouldPrefetch: true, priority: "high" },
      },
      {
        name: "prod + prefetch=false",
        input: { nodeEnv: "production", prefetch: false, isDangerous: false, intent: "intent" },
        expected: { shouldPrefetch: false },
      },
      {
        name: "prod + dangerous",
        input: { nodeEnv: "production", prefetch: undefined, isDangerous: true, intent: "intent" },
        expected: { shouldPrefetch: false },
      },
    ] satisfies Array<{
      name: string;
      input: {
        nodeEnv: string;
        prefetch: boolean | undefined;
        isDangerous: boolean;
        intent: LinkPrefetchIntent;
      };
      expected: LinkPrefetchDecision;
    }>;

    for (const testCase of cases) {
      expect(getLinkPrefetchDecision(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });

  it("normalizes only local or same-origin prefetch hrefs", () => {
    const cases = [
      {
        name: "local path",
        input: { href: "/local", basePath: "", currentOrigin: "https://example.com" },
        expected: "/local",
      },
      {
        name: "same-origin absolute URL",
        input: {
          href: "https://example.com/path",
          basePath: "",
          currentOrigin: "https://example.com",
        },
        expected: "/path",
      },
      {
        name: "same-origin protocol-relative URL",
        input: { href: "//example.com/path", basePath: "", currentOrigin: "https://example.com" },
        expected: "/path",
      },
      {
        name: "external absolute URL",
        input: {
          href: "https://external.com/path",
          basePath: "",
          currentOrigin: "https://example.com",
        },
        expected: null,
      },
      {
        name: "external protocol-relative URL",
        input: { href: "//external.com/path", basePath: "", currentOrigin: "https://example.com" },
        expected: null,
      },
      {
        name: "same-origin with basePath",
        input: {
          href: "https://example.com/docs/path?tab=1#section",
          basePath: "/docs",
          currentOrigin: "https://example.com",
        },
        expected: "/path?tab=1#section",
      },
      {
        name: "same-origin without required basePath",
        input: {
          href: "https://example.com/path",
          basePath: "/docs",
          currentOrigin: "https://example.com",
        },
        expected: null,
      },
    ] satisfies Array<{
      name: string;
      input: Parameters<typeof getLinkPrefetchHref>[0];
      expected: string | null;
    }>;

    for (const testCase of cases) {
      expect(getLinkPrefetchHref(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("react/jsx-runtime");
  vi.doUnmock("react/jsx-dev-runtime");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Link App Router navigation scheduling", () => {
  it("clicking an RSC Link starts app-router navigation inside a React transition", async () => {
    vi.resetModules();

    let capturedAnchorProps: CapturedAnchorProps | undefined;
    let transitionActive = false;
    const transitionStates: boolean[] = [];
    const startTransition = vi.fn((callback: () => void) => {
      transitionActive = true;
      try {
        callback();
      } finally {
        transitionActive = false;
      }
    });

    const captureAnchor = (type: unknown, props: unknown) => {
      if (type === "a" && props !== null && typeof props === "object") {
        capturedAnchorProps = props;
      }
    };

    mockReactAnchorCaptureForLinkOnly_DO_NOT_REUSE({ captureAnchor, startTransition });

    const navigate = vi.fn(async () => {
      transitionStates.push(transitionActive);
    });
    vi.stubGlobal("window", {
      __VINEXT_RSC_NAVIGATE__: navigate,
      addEventListener: vi.fn(),
      history: {
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
      location: {
        href: "https://example.com/current",
        origin: "https://example.com",
      },
      scrollTo: vi.fn(),
    });

    // Load link.js BEFORE importActual("react"). Earlier these two imports ran
    // in parallel via Promise.all, but that race made the mock occasionally not
    // intercept link.tsx's transitive `import React from "react"` — when
    // importActual won the race, "react" landed in the module cache as the
    // actual module first, and link.tsx's import then resolved to that cached
    // entry instead of the doMock factory. That caused React.startTransition
    // inside Link to be the real implementation rather than the spy, so the
    // assertion on `toHaveBeenCalledTimes(1)` would flake to 0.
    // Sequencing the imports guarantees the doMock factory runs first.
    const { default: IsolatedLink } = await import("../packages/vinext/src/shims/link.js");
    const React = await vi.importActual<typeof import("react")>("react");

    ReactDOMServer.renderToString(
      React.createElement(IsolatedLink, { href: "/target", prefetch: false }, "target"),
    );

    const clickEvent = {
      button: 0,
      currentTarget: { target: "" },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const onClick = capturedAnchorProps?.onClick;
    expect(onClick).toBeTypeOf("function");
    if (onClick === undefined) {
      throw new Error("Expected rendered Link anchor to expose an onClick handler");
    }
    await onClick(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(startTransition).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/target", 0, "navigate", "push", undefined, true);
    expect(transitionStates).toEqual([true]);
  });
});

async function renderIsolatedLink(options: {
  href: string;
  nodeEnv: string;
  props?: Record<string, unknown>;
  requireRef?: boolean;
  windowOverrides?: Record<string, unknown>;
}) {
  vi.resetModules();

  const restoreNodeEnv = () => {
    vi.unstubAllEnvs();
  };
  vi.stubEnv("NODE_ENV", options.nodeEnv);

  const effects: CapturedEffect[] = [];
  let capturedAnchorProps: CapturedAnchorProps | undefined;

  const captureAnchor = (type: unknown, props: unknown) => {
    if (type === "a" && props !== null && typeof props === "object") {
      capturedAnchorProps = props;
    }
  };

  mockReactAnchorCaptureForLinkOnly_DO_NOT_REUSE({
    captureAnchor,
    captureEffect(effect) {
      effects.push(effect);
    },
  });

  const fetch = vi.fn(() => Promise.resolve(new Response("")));
  const location = {
    href: "https://example.com/current",
    origin: "https://example.com",
  };

  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("window", {
    __VINEXT_RSC_NAVIGATE__: vi.fn(),
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    history: {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    },
    location,
    __VINEXT_LINK_PREFETCH_ROUTES__: linkPrefetchRoutes,
    requestIdleCallback: vi.fn((callback: () => void) => {
      callback();
      return 1;
    }),
    scrollTo: vi.fn(),
    ...options.windowOverrides,
  });

  const { default: IsolatedLink } = await import("../packages/vinext/src/shims/link.js");
  const React = await vi.importActual<typeof import("react")>("react");

  try {
    ReactDOMServer.renderToString(
      React.createElement(IsolatedLink, { href: options.href, ...options.props }, "target"),
    );

    if (capturedAnchorProps === undefined) {
      throw new Error("Expected rendered Link to expose anchor props");
    }

    if (options.requireRef !== false && capturedAnchorProps.ref === undefined) {
      throw new Error("Expected rendered Link anchor to expose a ref");
    }

    const anchor = { href: options.href } as HTMLAnchorElement;
    capturedAnchorProps.ref?.(anchor);

    for (const effect of effects) {
      effect();
    }

    return {
      anchor,
      capturedAnchorProps,
      fetch,
      restoreNodeEnv,
    };
  } catch (error) {
    restoreNodeEnv();
    throw error;
  }
}

describe("Link App Router prefetch scheduling", () => {
  function stubIntersectionObserver() {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    class FakeIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "250px";
      readonly thresholds = [0];

      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      observe = observe;
      unobserve = unobserve;
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    return {
      observe,
      unobserve,
      dispatchIntersectingEntry(anchor: HTMLAnchorElement) {
        const rect = {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
        intersectionCallback?.(
          [
            {
              boundingClientRect: rect,
              intersectionRatio: 1,
              intersectionRect: rect,
              isIntersecting: true,
              rootBounds: null,
              target: anchor,
              time: 0,
            },
          ],
          {} as IntersectionObserver,
        );
      },
    };
  }

  it("prefetches visible links in production with low priority", async () => {
    const observer = stubIntersectionObserver();

    const result = await renderIsolatedLink({
      href: "/viewport-prefetch-target",
      nodeEnv: "production",
    });

    try {
      expect(observer.observe).toHaveBeenCalledWith(result.anchor);
      observer.dispatchIntersectingEntry(result.anchor);
      await flushPrefetchTasks();

      expect(observer.unobserve).toHaveBeenCalledWith(result.anchor);
      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/viewport-prefetch-target.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "low",
        }),
      );
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not full-prefetch visible dynamic links in automatic production mode", async () => {
    const observer = stubIntersectionObserver();

    const result = await renderIsolatedLink({
      href: "/blog/hello",
      nodeEnv: "production",
    });

    try {
      expect(observer.observe).toHaveBeenCalledWith(result.anchor);
      observer.dispatchIntersectingEntry(result.anchor);
      await flushPrefetchTasks();

      expect(observer.unobserve).toHaveBeenCalledWith(result.anchor);
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("full-prefetches visible dynamic links when prefetch is explicitly true", async () => {
    const observer = stubIntersectionObserver();

    const result = await renderIsolatedLink({
      href: "/blog/hello",
      nodeEnv: "production",
      props: { prefetch: true },
    });

    try {
      expect(observer.observe).toHaveBeenCalledWith(result.anchor);
      observer.dispatchIntersectingEntry(result.anchor);
      await flushPrefetchTasks();

      expect(observer.unobserve).toHaveBeenCalledWith(result.anchor);
      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/blog/hello.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "low",
        }),
      );
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not prefetch visible links in development", async () => {
    // Next.js disables App Router viewport prefetching in development:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/links.ts
    const observe = vi.fn();
    const unobserve = vi.fn();
    class FakeIntersectionObserver {
      observe = observe;
      unobserve = unobserve;
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const result = await renderIsolatedLink({
      href: "/dev-prefetch-target",
      nodeEnv: "development",
    });

    try {
      expect(observe).not.toHaveBeenCalled();
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not prefetch on mouse intent in development while preserving the user handler", async () => {
    const userOnMouseEnter = vi.fn();
    const result = await renderIsolatedLink({
      href: "/dev-mouse-intent-prefetch-target",
      nodeEnv: "development",
      props: { onMouseEnter: userOnMouseEnter },
    });

    try {
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnMouseEnter).toHaveBeenCalledTimes(1);
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not prefetch on touch intent in development while preserving the user handler", async () => {
    const userOnTouchStart = vi.fn();
    const result = await renderIsolatedLink({
      href: "/dev-touch-intent-prefetch-target",
      nodeEnv: "development",
      props: { onTouchStart: userOnTouchStart },
    });

    try {
      result.capturedAnchorProps.onTouchStart?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnTouchStart).toHaveBeenCalledTimes(1);
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("prefetches on mouse intent in production while preserving the user handler", async () => {
    // Next.js triggers intent prefetch from Link onMouseEnter:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/app-dir/link.tsx
    const userOnMouseEnter = vi.fn();
    const result = await renderIsolatedLink({
      href: "/intent-prefetch-target",
      nodeEnv: "production",
      props: { onMouseEnter: userOnMouseEnter },
    });

    try {
      expect(result.capturedAnchorProps.onMouseEnter).toBeTypeOf("function");
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnMouseEnter).toHaveBeenCalledTimes(1);
      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/intent-prefetch-target.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "high",
        }),
      );
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("prefetches on touch intent in production while preserving the user handler", async () => {
    const userOnTouchStart = vi.fn();
    const result = await renderIsolatedLink({
      href: "/touch-prefetch-target",
      nodeEnv: "production",
      props: { onTouchStart: userOnTouchStart },
    });

    try {
      expect(result.capturedAnchorProps.onTouchStart).toBeTypeOf("function");
      result.capturedAnchorProps.onTouchStart?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnTouchStart).toHaveBeenCalledTimes(1);
      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/touch-prefetch-target.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "high",
        }),
      );
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not prefetch external absolute URLs on production intent", async () => {
    const userOnMouseEnter = vi.fn();
    const result = await renderIsolatedLink({
      href: "https://external.example/prefetch-target",
      nodeEnv: "production",
      props: { onMouseEnter: userOnMouseEnter },
    });

    try {
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnMouseEnter).toHaveBeenCalledTimes(1);
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("normalizes same-origin absolute URLs before production intent prefetch", async () => {
    const result = await renderIsolatedLink({
      href: "https://example.com/same-origin-intent-prefetch-target",
      nodeEnv: "production",
    });

    try {
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/same-origin-intent-prefetch-target.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "high",
        }),
      );
      expect(result.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("https://example.com/same-origin-intent-prefetch-target.rsc"),
        expect.anything(),
      );
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not prefetch external protocol-relative URLs on production intent", async () => {
    const result = await renderIsolatedLink({
      href: "//external.example/protocol-relative-prefetch-target",
      nodeEnv: "production",
    });

    try {
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not prefetch on intent when prefetch is false", async () => {
    const userOnMouseEnter = vi.fn();
    const result = await renderIsolatedLink({
      href: "/disabled-intent-prefetch-target",
      nodeEnv: "production",
      props: { onMouseEnter: userOnMouseEnter, prefetch: false },
    });

    try {
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnMouseEnter).toHaveBeenCalledTimes(1);
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not observe visible links when prefetch is false", async () => {
    const observe = vi.fn();
    const unobserve = vi.fn();
    class FakeIntersectionObserver {
      observe = observe;
      unobserve = unobserve;
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const result = await renderIsolatedLink({
      href: "/disabled-viewport-prefetch-target",
      nodeEnv: "production",
      props: { prefetch: false },
    });

    try {
      expect(observe).not.toHaveBeenCalled();
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("preserves user intent handlers on dangerous inert links", async () => {
    const userOnMouseEnter = vi.fn();
    const userOnTouchStart = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renderIsolatedLink({
      href: "javascript:alert(1)",
      nodeEnv: "development",
      props: {
        onMouseEnter: userOnMouseEnter,
        onTouchStart: userOnTouchStart,
      },
      requireRef: false,
    });

    try {
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      result.capturedAnchorProps.onTouchStart?.({ currentTarget: result.anchor });

      expect(userOnMouseEnter).toHaveBeenCalledTimes(1);
      expect(userOnTouchStart).toHaveBeenCalledTimes(1);
      expect(result.fetch).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
      result.restoreNodeEnv();
    }
  });
});
