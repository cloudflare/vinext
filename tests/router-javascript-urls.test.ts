import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import ReactDOMServer from "react-dom/server";
import type { ElementType, ReactNode } from "react";

// Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
//
// Next.js blocks dangerous URI schemes in router.push/replace/prefetch with a
// thrown Error: "Next.js has blocked a javascript: URL as a security precaution."
// See: packages/next/src/client/components/app-router-instance.ts:343,400,440,458
//
// The Next.js E2E test asserts the blocked navigation surfaces as a
// `console.error` whose message matches
//   "has blocked a javascript: URL as a security precaution."
// In Next.js, the thrown Error is caught by React's event-handler runtime and
// reported via `console.error`. Vinext's Link/router shims do not always
// propagate through React (e.g. Link click handlers are async, and async
// throws are not reported to React). To match the observable Next.js
// behaviour, vinext emits a `console.error` with the same message before the
// throw, so the assertion fires in both unit-test and browser contexts.
//
// Vinext mirrors that behavior. The guard runs before any programmatic
// navigation kicks off, at the top of push/replace/prefetch. Even server-side
// calls throw, matching Next.js intent and giving SSR-safe regression coverage
// in node-based unit tests.
//
// Coverage split:
//   Ported from the Next.js E2E suite above: javascript: cases for
//     push/replace/prefetch plus the obfuscation variants that Next.js's
//     javascript-url.ts regex covers (uppercase, embedded tabs, leading
//     whitespace).
//   Vinext-only extensions: data: and vbscript: cases. Vinext intentionally
//     extends the dangerous-scheme block to those schemes via the shared
//     isDangerousScheme helper. Rationale and scope: shims/url-safety.ts:20-21.

const BLOCK_MESSAGE = "Next.js has blocked a javascript: URL as a security precaution.";

describe("App Router appRouterInstance blocks dangerous URI schemes", () => {
  it("router.push throws on javascript: URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.push("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.replace throws on javascript: URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.replace("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.prefetch throws on javascript: URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.prefetch("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on data: URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.push("data:text/html,<script>alert(1)</script>")).toThrow(
      BLOCK_MESSAGE,
    );
  });

  it("router.push throws on vbscript: URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.push("vbscript:MsgBox(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on obfuscated javascript: URL with embedded tabs", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.push("java\tscript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on uppercase JAVASCRIPT: URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.push("JAVASCRIPT:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  it("router.push throws on leading-whitespace javascript: URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.push("   javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
  });

  // Safe URLs must not throw — guard must not over-block.
  it("router.push does not throw on a normal pathname", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.push("/safe")).not.toThrow();
  });

  it("router.replace does not throw on absolute https URL", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.replace("https://example.com/path")).not.toThrow();
  });

  it("router.prefetch does not throw on a normal pathname", async () => {
    const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
    expect(() => appRouterInstance.prefetch("/safe")).not.toThrow();
  });
});

describe("App Router appRouterInstance emits console.error on dangerous URI schemes", () => {
  it("router.push logs to console.error before throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
      expect(() => appRouterInstance.push("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("router.replace logs to console.error before throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
      expect(() => appRouterInstance.replace("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("router.prefetch logs to console.error before throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
      expect(() => appRouterInstance.prefetch("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not log when the URL is safe", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { appRouterInstance } = await import("../packages/vinext/src/shims/navigation.js");
      appRouterInstance.push("/safe");
      expect(consoleError).not.toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// Pages Router parity: next/router push/replace must also block dangerous
// URI schemes with both a throw and a matching console.error. Mirrors
// Next.js's `packages/next/src/shared/lib/router/router.ts:1020,1052`, where
// push/replace throw the same error message *synchronously* (before any
// async work) so React's event-handler error reporter can surface the
// console.error to the user.
describe("Pages Router next/router blocks dangerous URI schemes", () => {
  // Minimal fake window/document so importing shims/router.ts (which touches
  // window at module load to attach popstate) does not crash. Installed by
  // the helper below; restored in `afterEach`.
  function installFakeBrowserGlobals() {
    const previousWindow = (globalThis as { window?: unknown }).window;
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = {
      location: {
        pathname: "/",
        search: "",
        hash: "",
        href: "http://localhost/",
        origin: "http://localhost",
      },
      history: { state: null, pushState() {}, replaceState() {} },
      addEventListener() {},
      dispatchEvent() {},
    };
    (globalThis as { document?: unknown }).document = {
      addEventListener() {},
    };
    return () => {
      (globalThis as { window?: unknown }).window = previousWindow as never;
      (globalThis as { document?: unknown }).document = previousDocument as never;
    };
  }

  afterEach(() => {
    vi.resetModules();
  });

  it("Router.push throws synchronously on javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      // Next.js's Pages Router `push` throws synchronously inside the push()
      // call so React's event-handler error reporter can surface
      // `console.error`. Mirror that here (do not await the call).
      expect(() => Router.push("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.replace throws synchronously on javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      expect(() => Router.replace("javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.push throws synchronously when only `as` is a javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      expect(() => Router.push("/safe", "javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.replace throws synchronously when only `as` is a javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      expect(() => Router.replace("/safe", "javascript:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.push throws synchronously on uppercase JAVASCRIPT: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      expect(() => Router.push("JAVASCRIPT:alert(1)")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.push throws synchronously on data: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      expect(() => Router.push("data:text/html,<script>alert(1)</script>")).toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  // Regression coverage: `Router.push(...)` must throw *before* returning the
  // Promise. If it ever regresses to throwing inside the async
  // `performNavigation` body, the throw would be wrapped in a rejected
  // Promise that React's event-handler runtime does not observe, and the
  // matching `console.error` would not be reported through page logs (the
  // failure mode covered by Next.js's
  // `test/e2e/app-dir/javascript-urls/javascript-urls.test.ts:341,376`).
  it("Router.push throws synchronously (does not return a rejected Promise)", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      let threw = false;
      let returned: unknown = "not-called";
      try {
        returned = Router.push("javascript:alert(1)");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // The synchronous throw means no value was ever returned.
      expect(returned).toBe("not-called");
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });
});

// Pages Router parity: clicking a `<Link>` whose resolved navigation target
// (either `href` or the legacy `as` prop) is a dangerous URI scheme must emit
// the same `console.error` and must never navigate. The Link shim is shared
// between App Router and Pages Router, so this guards the Pages Router
// `link-href` / `link-as` scenarios from
// `test/e2e/app-dir/javascript-urls/javascript-urls.test.ts` (the four
// `pages router` cases). The browser-level coverage lives in
// tests/e2e/pages-router/javascript-urls.spec.ts; this unit test pins the
// click handler behaviour the e2e suite depends on. Part of issue #1576.
describe("Pages Router next/link blocks dangerous URI schemes on click", () => {
  let restoreWindowGlobal: (() => void) | undefined;

  afterEach(() => {
    restoreWindowGlobal?.();
    restoreWindowGlobal = undefined;
    vi.resetModules();
  });

  // Render the Link shim to capture the anchor's onClick handler, then invoke
  // it. The shim emits the anchor through both React.createElement and the
  // jsx runtime depending on the build, so both are intercepted.
  async function renderLinkAndClick(
    href: string,
    props: Record<string, unknown> = {},
    options: { click?: boolean } = {},
  ): Promise<{
    consoleError: ReturnType<typeof vi.spyOn>;
    clickHandled: boolean;
  }> {
    const { click = true } = options;
    vi.resetModules();

    let capturedOnClick: ((event: unknown) => unknown) | undefined;
    const captureAnchor = (type: unknown, p: unknown): void => {
      if (type === "a" && p !== null && typeof p === "object") {
        const onClick = (p as { onClick?: (event: unknown) => unknown }).onClick;
        if (typeof onClick === "function") capturedOnClick = onClick;
      }
    };

    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      const createElement = ((
        type: ElementType,
        p: Record<string, unknown> | null,
        ...children: ReactNode[]
      ) => {
        captureAnchor(type, p);
        return actual.createElement(type, p, ...children);
      }) as typeof actual.createElement;
      return { ...actual, createElement, default: { ...actual, createElement } };
    });
    vi.doMock("react/jsx-runtime", async () => {
      const actual = await vi.importActual<typeof import("react/jsx-runtime")>("react/jsx-runtime");
      return {
        ...actual,
        jsx(type: ElementType, p: Record<string, unknown>, key?: string) {
          captureAnchor(type, p);
          return actual.jsx(type, p, key);
        },
        jsxs(type: ElementType, p: Record<string, unknown>, key?: string) {
          captureAnchor(type, p);
          return actual.jsxs(type, p, key);
        },
      };
    });
    vi.doMock("react/jsx-dev-runtime", async () => {
      const actual =
        await vi.importActual<typeof import("react/jsx-dev-runtime")>("react/jsx-dev-runtime");
      const jsxRuntime =
        await vi.importActual<typeof import("react/jsx-runtime")>("react/jsx-runtime");
      return {
        ...actual,
        jsxDEV(
          type: ElementType,
          p: Record<string, unknown>,
          key?: string,
          isStaticChildren?: boolean,
          source?: Parameters<typeof actual.jsxDEV>[4],
          self?: Parameters<typeof actual.jsxDEV>[5],
        ) {
          captureAnchor(type, p);
          if (typeof actual.jsxDEV === "function") {
            return actual.jsxDEV(type, p, key, isStaticChildren ?? false, source, self);
          }
          return jsxRuntime.jsx(type, p, key);
        },
      };
    });

    // Minimal browser globals so the safe-href control case (which reaches the
    // shim's real `handleClick`, including its async fallback that touches
    // `window.history`) does not crash. The dangerous cases short-circuit to an
    // inert anchor before any navigation. Restored in `afterEach` (not here),
    // because `handleClick`'s async navigation can settle after this returns.
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: {
        pathname: "/",
        search: "",
        hash: "",
        href: "http://localhost/",
        origin: "http://localhost",
        assign() {},
        replace() {},
      },
      history: { state: null, pushState() {}, replaceState() {} },
      addEventListener() {},
      dispatchEvent() {},
      scrollTo() {},
    };
    restoreWindowGlobal = () => {
      (globalThis as { window?: unknown }).window = previousWindow as never;
    };

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: Link } = await import("../packages/vinext/src/shims/link.js");
    const React = await vi.importActual<typeof import("react")>("react");

    ReactDOMServer.renderToString(
      React.createElement(Link, { href, prefetch: false, ...props }, "target"),
    );

    const event = {
      button: 0,
      currentTarget: { hasAttribute: () => false, target: "" },
      defaultPrevented: false,
      preventDefault() {
        (this as { defaultPrevented: boolean }).defaultPrevented = true;
      },
    };

    let clickHandled = false;
    if (click && typeof capturedOnClick === "function") {
      clickHandled = true;
      await capturedOnClick(event);
    }

    return { consoleError, clickHandled };
  }

  it("Link href javascript: emits console.error on click and blocks navigation", async () => {
    const { consoleError, clickHandled } = await renderLinkAndClick("javascript:alert(1)");
    try {
      expect(clickHandled).toBe(true);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("Link as javascript: emits console.error on click and blocks navigation", async () => {
    const { consoleError, clickHandled } = await renderLinkAndClick("/safe", {
      as: "javascript:alert(1)",
    });
    try {
      expect(clickHandled).toBe(true);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("Link with a safe href does not emit the block message", async () => {
    // Render only (no click): a safe Link must not be treated as dangerous, so
    // the block message must never be emitted. We skip invoking the click here
    // because a safe click delegates to the real async navigation machinery,
    // which is out of scope for this guard.
    const { consoleError } = await renderLinkAndClick("/safe", {}, { click: false });
    try {
      expect(consoleError).not.toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
    }
  });
});
