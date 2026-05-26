import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import ReactDOMServer from "react-dom/server";
import type { ElementType, ReactNode } from "react";
import {
  getLinkPrefetchDecision,
  getLinkPrefetchHref,
  type LinkPrefetchIntent,
  type LinkPrefetchDecision,
  type LinkPrefetchRouterMode,
} from "../packages/vinext/src/shims/link-prefetch.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "../packages/vinext/src/server/app-rsc-render-mode.js";
import { VINEXT_RSC_RENDER_MODE_HEADER } from "../packages/vinext/src/server/headers.js";
import type { VinextLinkPrefetchRoute } from "../packages/vinext/src/client/vinext-next-data.js";

type CapturedEffect = () => void | (() => void);

type CapturedClickEvent = {
  altKey?: boolean;
  button: number;
  ctrlKey?: boolean;
  currentTarget: { hasAttribute(name: string): boolean; target: string };
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

type CapturedPrefetchLinkElement = {
  as?: string;
  href?: string;
  rel?: string;
};

const linkPrefetchRoutes = [
  { canPrefetchLoadingShell: false, patternParts: ["viewport-prefetch-target"], isDynamic: false },
  { canPrefetchLoadingShell: false, patternParts: ["intent-prefetch-target"], isDynamic: false },
  { canPrefetchLoadingShell: false, patternParts: ["touch-prefetch-target"], isDynamic: false },
  {
    canPrefetchLoadingShell: false,
    patternParts: ["same-origin-intent-prefetch-target"],
    isDynamic: false,
  },
  { canPrefetchLoadingShell: true, patternParts: ["blog", ":slug"], isDynamic: true },
  { canPrefetchLoadingShell: false, patternParts: ["products", ":id"], isDynamic: true },
] satisfies VinextLinkPrefetchRoute[];

function createTestNavigationRuntime(navigate: unknown) {
  return {
    bootstrap: {
      routeManifest: null,
      rsc: undefined,
    },
    functions: {
      navigate,
    },
  };
}

function pingVisibleLinksFromRuntime(): void {
  const runtime: unknown = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
  if (typeof runtime !== "object" || runtime === null || !("functions" in runtime)) return;
  const { functions } = runtime;
  if (typeof functions !== "object" || functions === null || !("pingVisibleLinks" in functions)) {
    return;
  }
  const { pingVisibleLinks } = functions;
  if (typeof pingVisibleLinks === "function") {
    pingVisibleLinks();
  }
}

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
  // IIFE with awaited request-header hashing and cache writes. These ticks
  // drain the current chain; update this helper if the async depth grows.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForFetchCalls(
  fetch: { mock: { calls: unknown[] } },
  expectedCalls: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await flushPrefetchTasks();
    if (fetch.mock.calls.length >= expectedCalls) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
        name: "prod + app intent + prefetch=false",
        input: { nodeEnv: "production", prefetch: false, isDangerous: false, intent: "intent" },
        expected: { shouldPrefetch: false },
      },
      {
        name: "prod + pages intent + prefetch=false",
        input: {
          nodeEnv: "production",
          prefetch: false,
          isDangerous: false,
          intent: "intent",
          routerMode: "pages",
        },
        expected: { shouldPrefetch: true, priority: "high" },
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
        routerMode?: LinkPrefetchRouterMode;
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
        name: "mailto URL",
        input: {
          href: "mailto:hello@example.com",
          basePath: "",
          currentOrigin: "https://example.com",
        },
        expected: null,
      },
      {
        name: "tel URL",
        input: { href: "tel:+123456789", basePath: "", currentOrigin: "https://example.com" },
        expected: null,
      },
      {
        name: "sms URL",
        input: { href: "sms:+123456789", basePath: "", currentOrigin: "https://example.com" },
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
      [Symbol.for("vinext.navigationRuntime")]: {
        bootstrap: {
          routeManifest: null,
          rsc: undefined,
        },
        functions: {
          navigate,
        },
      },
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
      currentTarget: { hasAttribute: () => false, target: "" },
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
    expect(navigate).toHaveBeenCalledWith(
      "/target",
      0,
      "navigate",
      "push",
      undefined,
      true,
      undefined,
      expect.objectContaining({
        commitId: null,
        hash: null,
        id: expect.any(Number),
      }),
    );
    expect(transitionStates).toEqual([true]);
  });

  it("lets the browser handle native URI schemes without app-router navigation", async () => {
    const userOnClick = vi.fn();
    const hrefs = ["mailto:hello@example.com", "tel:+123456789", "sms:+123456789"];

    for (const href of hrefs) {
      const result = await renderIsolatedLink({
        href,
        nodeEnv: "production",
        props: { onClick: userOnClick, prefetch: false },
        requireRef: false,
      });

      try {
        const clickEvent = {
          button: 0,
          currentTarget: { hasAttribute: () => false, target: "" },
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
        };
        const onClick = result.capturedAnchorProps.onClick;
        expect(onClick).toBeTypeOf("function");
        if (onClick === undefined) {
          throw new Error("Expected rendered Link anchor to expose an onClick handler");
        }

        await onClick(clickEvent);

        expect(userOnClick).toHaveBeenCalledWith(clickEvent);
        expect(clickEvent.defaultPrevented).toBe(false);
        expect(result.navigate).not.toHaveBeenCalled();
      } finally {
        result.restoreNodeEnv();
      }
    }
  });

  it("lets the browser handle download links without app-router navigation", async () => {
    vi.resetModules();

    let capturedAnchorProps: CapturedAnchorProps | undefined;
    const startTransition = vi.fn((callback: () => void) => {
      callback();
    });

    const captureAnchor = (type: unknown, props: unknown) => {
      if (type === "a" && props !== null && typeof props === "object") {
        capturedAnchorProps = props;
      }
    };

    mockReactAnchorCaptureForLinkOnly_DO_NOT_REUSE({ captureAnchor, startTransition });

    const navigate = vi.fn(async () => {});
    vi.stubGlobal("window", {
      [Symbol.for("vinext.navigationRuntime")]: {
        bootstrap: {
          routeManifest: null,
          rsc: undefined,
        },
        functions: {
          navigate,
        },
      },
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

    const { default: IsolatedLink } = await import("../packages/vinext/src/shims/link.js");
    const React = await vi.importActual<typeof import("react")>("react");
    const onClick = vi.fn();
    const onNavigate = vi.fn();

    // Ported from Next.js: test/e2e/link-on-navigate-prop/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/link-on-navigate-prop/index.test.ts
    ReactDOMServer.renderToString(
      React.createElement(
        IsolatedLink,
        { download: true, href: "/file.pdf", onClick, onNavigate, prefetch: false },
        "download",
      ),
    );

    const clickEvent = {
      button: 0,
      currentTarget: {
        hasAttribute: (name: string) => name === "download",
        target: "",
      },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const linkOnClick = capturedAnchorProps?.onClick;
    expect(linkOnClick).toBeTypeOf("function");
    if (linkOnClick === undefined) {
      throw new Error("Expected rendered Link anchor to expose an onClick handler");
    }
    await linkOnClick(clickEvent);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(startTransition).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Link onNavigate prop — Next.js 15 contract
//
// Ported from Next.js: test/e2e/link-on-navigate-prop/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/link-on-navigate-prop/index.test.ts
//
// The Next.js contract (see `.nextjs-ref/packages/next/src/client/link.tsx`
// `linkClicked`) is:
//   1. onClick always fires first (regardless of modifier, target, download,
//      or external href).
//   2. onNavigate only fires when the Link is about to perform its own
//      client-side navigation: skipped for modifier-key clicks, target=_blank,
//      download links, and truly external URLs.
//   3. Calling `event.preventDefault()` inside onNavigate cancels the Link's
//      navigation.
//   4. External URLs with the `replace` prop must call
//      `window.location.replace()` instead of letting the browser push.
// ---------------------------------------------------------------------------
describe("Link onNavigate prop", () => {
  type NavigateEventLike = {
    preventDefault(): void;
    defaultPrevented?: boolean;
    url?: URL;
  };

  async function renderLinkAndClick(args: {
    href: string;
    props?: Record<string, unknown>;
    clickEvent: Partial<{
      altKey: boolean;
      button: number;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      currentTarget: { hasAttribute(name: string): boolean; target: string };
    }>;
    locationOverrides?: Record<string, unknown>;
  }) {
    vi.resetModules();

    let capturedAnchorProps: CapturedAnchorProps | undefined;
    const startTransition = vi.fn((callback: () => void) => {
      callback();
    });

    const captureAnchor = (type: unknown, props: unknown) => {
      if (type === "a" && props !== null && typeof props === "object") {
        capturedAnchorProps = props;
      }
    };

    mockReactAnchorCaptureForLinkOnly_DO_NOT_REUSE({ captureAnchor, startTransition });

    const navigate = vi.fn(async () => {});
    const locationReplace = vi.fn();
    const locationAssign = vi.fn();
    const pushState = vi.fn();
    const replaceState = vi.fn();

    vi.stubGlobal("window", {
      [Symbol.for("vinext.navigationRuntime")]: {
        bootstrap: { routeManifest: null, rsc: undefined },
        functions: { navigate },
      },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      history: { pushState, replaceState },
      location: {
        href: "https://example.com/current",
        origin: "https://example.com",
        replace: locationReplace,
        assign: locationAssign,
        ...args.locationOverrides,
      },
      scrollTo: vi.fn(),
    });

    const { default: IsolatedLink } = await import("../packages/vinext/src/shims/link.js");
    const React = await vi.importActual<typeof import("react")>("react");

    ReactDOMServer.renderToString(
      React.createElement(
        IsolatedLink,
        { href: args.href, prefetch: false, ...args.props },
        "target",
      ),
    );

    const onClickHandler = capturedAnchorProps?.onClick;
    if (typeof onClickHandler !== "function") {
      throw new Error("Expected rendered Link anchor to expose an onClick handler");
    }

    const clickEvent = {
      button: 0,
      currentTarget: { hasAttribute: () => false, target: "" },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...args.clickEvent,
    };

    await onClickHandler(clickEvent);

    return {
      clickEvent,
      locationReplace,
      locationAssign,
      navigate,
      startTransition,
      pushState,
      replaceState,
    };
  }

  it("fires onClick and onNavigate for an internal click", async () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn();

    const result = await renderLinkAndClick({
      href: "/subpage",
      props: { onClick, onNavigate },
      clickEvent: {},
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(result.clickEvent.defaultPrevented).toBe(true);
    expect(result.navigate).toHaveBeenCalledTimes(1);
  });

  it("passes a NavigateEvent exposing preventDefault to onNavigate", async () => {
    let received: NavigateEventLike | undefined;
    const onNavigate = vi.fn((event: NavigateEventLike) => {
      received = event;
    });

    await renderLinkAndClick({
      href: "/subpage",
      props: { onNavigate },
      clickEvent: {},
    });

    expect(typeof received?.preventDefault).toBe("function");
  });

  it("cancels navigation when onNavigate calls preventDefault", async () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn((event: NavigateEventLike) => {
      event.preventDefault();
    });

    const result = await renderLinkAndClick({
      href: "/subpage",
      props: { onClick, onNavigate },
      clickEvent: {},
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // Link still calls preventDefault on the click so the <a> doesn't navigate.
    expect(result.clickEvent.defaultPrevented).toBe(true);
    // ...but the client-side navigation must not happen.
    expect(result.navigate).not.toHaveBeenCalled();
  });

  it("fires onClick but skips onNavigate when a modifier key is held", async () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn();

    const result = await renderLinkAndClick({
      href: "/subpage",
      props: { onClick, onNavigate },
      clickEvent: { metaKey: true },
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    // Browser default must run so the modifier-key shortcut still opens a tab.
    expect(result.clickEvent.defaultPrevented).toBe(false);
    expect(result.navigate).not.toHaveBeenCalled();
  });

  it("fires onClick but skips onNavigate for target=_blank", async () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn();

    const result = await renderLinkAndClick({
      href: "/subpage",
      props: { onClick, onNavigate, target: "_blank" },
      clickEvent: {
        currentTarget: { hasAttribute: () => false, target: "_blank" },
      },
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(result.clickEvent.defaultPrevented).toBe(false);
    expect(result.navigate).not.toHaveBeenCalled();
  });

  it("fires onClick but skips onNavigate for download links", async () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn();

    const result = await renderLinkAndClick({
      href: "/zip.zip",
      props: { download: true, onClick, onNavigate },
      clickEvent: {
        currentTarget: {
          hasAttribute: (name: string) => name === "download",
          target: "",
        },
      },
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(result.clickEvent.defaultPrevented).toBe(false);
    expect(result.navigate).not.toHaveBeenCalled();
  });

  it("fires onClick but skips onNavigate for external URLs", async () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn();

    const result = await renderLinkAndClick({
      href: "https://example.org/about",
      props: { onClick, onNavigate },
      clickEvent: {},
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    // Without replace, the browser's default click navigation handles it.
    expect(result.clickEvent.defaultPrevented).toBe(false);
    expect(result.locationReplace).not.toHaveBeenCalled();
    expect(result.navigate).not.toHaveBeenCalled();
  });

  it("calls location.replace for external URLs with the replace prop", async () => {
    const onClick = vi.fn();
    const onNavigate = vi.fn();

    const result = await renderLinkAndClick({
      href: "https://example.org/about",
      props: { replace: true, onClick, onNavigate },
      clickEvent: {},
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    // Browser default would push — we must prevent it so the replace below
    // doesn't end up creating a second history entry.
    expect(result.clickEvent.defaultPrevented).toBe(true);
    expect(result.locationReplace).toHaveBeenCalledTimes(1);
    expect(result.locationReplace).toHaveBeenCalledWith("https://example.org/about");
  });
});

async function renderIsolatedLink(options: {
  appNavigation?: boolean;
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

  const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response("")),
  );
  const navigate = vi.fn();
  const pagePrefetchLinks: CapturedPrefetchLinkElement[] = [];
  const location = {
    href: "https://example.com/current",
    origin: "https://example.com",
  };
  const navigationRuntime =
    options.appNavigation === false ? undefined : createTestNavigationRuntime(navigate);

  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({})),
    head: {
      appendChild: vi.fn((node: CapturedPrefetchLinkElement) => {
        pagePrefetchLinks.push(node);
      }),
    },
  });
  vi.stubGlobal("window", {
    ...(navigationRuntime === undefined
      ? {}
      : { [Symbol.for("vinext.navigationRuntime")]: navigationRuntime }),
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
      navigate,
      pagePrefetchLinks,
      restoreNodeEnv,
    };
  } catch (error) {
    restoreNodeEnv();
    throw error;
  }
}

describe("Link prefetch scheduling", () => {
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
      dispatchIntersectingEntry(anchor: HTMLAnchorElement, isIntersecting = true) {
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
              intersectionRatio: isIntersecting ? 1 : 0,
              intersectionRect: rect,
              isIntersecting,
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
      await waitForFetchCalls(result.fetch, 1);

      expect(observer.unobserve).not.toHaveBeenCalledWith(result.anchor);
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

  it("re-prefetches visible links after the prefetch cache is invalidated", async () => {
    const observer = stubIntersectionObserver();

    const result = await renderIsolatedLink({
      href: "/viewport-prefetch-target",
      nodeEnv: "production",
    });
    const { invalidatePrefetchCache } = await import("../packages/vinext/src/shims/navigation.js");

    try {
      observer.dispatchIntersectingEntry(result.anchor);
      await flushPrefetchTasks();
      expect(result.fetch).toHaveBeenCalledTimes(1);

      invalidatePrefetchCache();
      await flushPrefetchTasks();

      expect(result.fetch).toHaveBeenCalledTimes(2);
      expect(result.fetch).toHaveBeenLastCalledWith(
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

  it("prefetches visible dynamic links in automatic production mode without seeding navigation cache", async () => {
    const observer = stubIntersectionObserver();

    const result = await renderIsolatedLink({
      href: "/blog/hello",
      nodeEnv: "production",
    });

    try {
      expect(observer.observe).toHaveBeenCalledWith(result.anchor);
      observer.dispatchIntersectingEntry(result.anchor);
      await waitForFetchCalls(result.fetch, 1);

      expect(observer.unobserve).not.toHaveBeenCalledWith(result.anchor);
      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/blog/hello.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "low",
        }),
      );
      const fetchInit = result.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
      expect((fetchInit?.headers as Headers | undefined)?.get(VINEXT_RSC_RENDER_MODE_HEADER)).toBe(
        APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
      );
      const { getPrefetchCache } = await import("../packages/vinext/src/shims/navigation.js");
      const entry = Array.from(getPrefetchCache().values())[0];
      expect(entry?.cacheForNavigation).toBe(false);
      expect(entry?.optimisticRouteShell).toBe(true);
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not auto-prefetch dynamic links without a loading shell boundary", async () => {
    const observer = stubIntersectionObserver();

    const result = await renderIsolatedLink({
      href: "/products/1",
      nodeEnv: "production",
    });

    try {
      expect(observer.observe).toHaveBeenCalledWith(result.anchor);
      observer.dispatchIntersectingEntry(result.anchor);
      await flushPrefetchTasks();

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

      expect(observer.unobserve).not.toHaveBeenCalledWith(result.anchor);
      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/blog/hello.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "low",
        }),
      );
      const fetchInit = result.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(
        (fetchInit?.headers as Headers | undefined)?.get(VINEXT_RSC_RENDER_MODE_HEADER),
      ).toBeNull();
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

  it("upgrades automatic dynamic links to full prefetch on unstable_dynamicOnHover intent", async () => {
    const observer = stubIntersectionObserver();
    const result = await renderIsolatedLink({
      href: "/blog/hello",
      nodeEnv: "production",
      props: { unstable_dynamicOnHover: true },
    });
    const { invalidatePrefetchCache } = await import("../packages/vinext/src/shims/navigation.js");

    try {
      observer.dispatchIntersectingEntry(result.anchor);
      await waitForFetchCalls(result.fetch, 1);
      expect(result.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/blog/hello.rsc"),
        expect.objectContaining({
          credentials: "include",
          priority: "low",
        }),
      );

      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await waitForFetchCalls(result.fetch, 2);

      expect(result.fetch).toHaveBeenCalledTimes(2);
      const hoverFetchInit = result.fetch.mock.calls[1]?.[1] as RequestInit | undefined;
      expect(
        (hoverFetchInit?.headers as Headers | undefined)?.get(VINEXT_RSC_RENDER_MODE_HEADER),
      ).toBeNull();
      const { getPrefetchCache } = await import("../packages/vinext/src/shims/navigation.js");
      const entries = Array.from(getPrefetchCache().values());
      expect(entries.some((entry) => entry.optimisticRouteShell === true)).toBe(true);
      expect(
        entries.some(
          (entry) => entry.cacheForNavigation === true && entry.optimisticRouteShell !== true,
        ),
      ).toBe(true);

      invalidatePrefetchCache();
      await waitForFetchCalls(result.fetch, 3);

      expect(result.fetch).toHaveBeenCalledTimes(3);
      expect(result.fetch).toHaveBeenLastCalledWith(
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

  it("does not prefetch native URI schemes on production intent", async () => {
    const result = await renderIsolatedLink({
      href: "mailto:hello@example.com",
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

  it("does not App Router prefetch on intent when prefetch is false", async () => {
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

  it("prefetches Pages Router links on mouse intent when prefetch is false", async () => {
    const userOnMouseEnter = vi.fn();
    const result = await renderIsolatedLink({
      appNavigation: false,
      href: "/pages-disabled-mouse-intent-prefetch-target",
      nodeEnv: "production",
      props: { onMouseEnter: userOnMouseEnter, prefetch: false },
      windowOverrides: {
        __NEXT_DATA__: {
          __vinext: {
            pageModuleUrl: "/_next/static/chunks/pages/current.js",
          },
        },
      },
    });

    try {
      result.capturedAnchorProps.onMouseEnter?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnMouseEnter).toHaveBeenCalledTimes(1);
      expect(result.fetch).not.toHaveBeenCalled();
      expect(result.pagePrefetchLinks).toEqual([
        {
          as: "document",
          href: "/pages-disabled-mouse-intent-prefetch-target",
          rel: "prefetch",
        },
      ]);
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("prefetches Pages Router links on touch intent when prefetch is false", async () => {
    const userOnTouchStart = vi.fn();
    const result = await renderIsolatedLink({
      appNavigation: false,
      href: "/pages-disabled-touch-intent-prefetch-target",
      nodeEnv: "production",
      props: { onTouchStart: userOnTouchStart, prefetch: false },
      windowOverrides: {
        __NEXT_DATA__: {
          __vinext: {
            pageModuleUrl: "/_next/static/chunks/pages/current.js",
          },
        },
      },
    });

    try {
      result.capturedAnchorProps.onTouchStart?.({ currentTarget: result.anchor });
      await flushPrefetchTasks();

      expect(userOnTouchStart).toHaveBeenCalledTimes(1);
      expect(result.fetch).not.toHaveBeenCalled();
      expect(result.pagePrefetchLinks).toEqual([
        {
          as: "document",
          href: "/pages-disabled-touch-intent-prefetch-target",
          rel: "prefetch",
        },
      ]);
    } finally {
      result.restoreNodeEnv();
    }
  });

  it("does not duplicate Pages Router viewport prefetch after visibility changes", async () => {
    const observer = stubIntersectionObserver();
    const result = await renderIsolatedLink({
      appNavigation: false,
      href: "/pages-viewport-prefetch-target",
      nodeEnv: "production",
      windowOverrides: {
        __NEXT_DATA__: {
          __vinext: {
            pageModuleUrl: "/_next/static/chunks/pages/current.js",
          },
        },
      },
    });

    try {
      observer.dispatchIntersectingEntry(result.anchor, true);
      await flushPrefetchTasks();
      observer.dispatchIntersectingEntry(result.anchor, false);
      await flushPrefetchTasks();
      observer.dispatchIntersectingEntry(result.anchor, true);
      await flushPrefetchTasks();
      pingVisibleLinksFromRuntime();
      await flushPrefetchTasks();

      expect(result.fetch).not.toHaveBeenCalled();
      expect(result.pagePrefetchLinks).toEqual([
        {
          as: "document",
          href: "/pages-viewport-prefetch-target",
          rel: "prefetch",
        },
      ]);
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

  // Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
  // The Next.js test asserts a console.error log appears whose message
  // includes "has blocked a javascript: URL as a security precaution.".
  it("emits a console.error matching Next.js when a dangerous Link is clicked", async () => {
    const userOnClick = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await renderIsolatedLink({
      href: "javascript:alert(1)",
      nodeEnv: "development",
      props: {
        onClick: userOnClick,
      },
      requireRef: false,
    });

    try {
      const onClick = result.capturedAnchorProps.onClick;
      expect(onClick).toBeTypeOf("function");
      const clickEvent = {
        button: 0,
        currentTarget: { hasAttribute: () => false, target: "" },
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      } satisfies CapturedClickEvent;

      await onClick?.(clickEvent);

      // User onClick still fires so callers can run analytics/preventDefault.
      expect(userOnClick).toHaveBeenCalledWith(clickEvent);
      // Navigation never happens.
      expect(result.navigate).not.toHaveBeenCalled();
      expect(result.fetch).not.toHaveBeenCalled();
      // Next.js parity: a console.error is emitted that includes the block
      // message — the E2E suite asserts on `.includes(...)` against this text.
      expect(
        consoleError.mock.calls.some((call) =>
          call.some(
            (arg) =>
              typeof arg === "string" &&
              arg.includes("has blocked a javascript: URL as a security precaution."),
          ),
        ),
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      result.restoreNodeEnv();
    }
  });
});
