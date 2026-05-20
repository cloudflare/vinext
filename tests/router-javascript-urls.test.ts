import { afterEach, describe, it, expect, vi } from "vite-plus/test";

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
// push/replace throw the same error message.
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

  it("Router.push rejects on javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      await expect(Router.push("javascript:alert(1)")).rejects.toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.replace rejects on javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      await expect(Router.replace("javascript:alert(1)")).rejects.toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.push rejects when only `as` is a javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      await expect(Router.push("/safe", "javascript:alert(1)")).rejects.toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.replace rejects when only `as` is a javascript: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      await expect(Router.replace("/safe", "javascript:alert(1)")).rejects.toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.push rejects on uppercase JAVASCRIPT: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      await expect(Router.push("JAVASCRIPT:alert(1)")).rejects.toThrow(BLOCK_MESSAGE);
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });

  it("Router.push rejects on data: URL", async () => {
    const restoreBrowserGlobals = installFakeBrowserGlobals();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;
      await expect(Router.push("data:text/html,<script>alert(1)</script>")).rejects.toThrow(
        BLOCK_MESSAGE,
      );
      expect(consoleError).toHaveBeenCalledWith(BLOCK_MESSAGE);
    } finally {
      consoleError.mockRestore();
      restoreBrowserGlobals();
    }
  });
});
