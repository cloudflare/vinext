import { describe, it, expect } from "vite-plus/test";
import {
  createRootParamsUsageController,
  getRootParam,
  runWithRootParamsScope,
  runWithRootParamsUsage,
} from "../packages/vinext/src/shims/root-params.js";
import {
  runWithRequestContext,
  createRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { runWithNavigationContext } from "../packages/vinext/src/shims/navigation-state.js";
import {
  getNavigationContext,
  setNavigationContext,
} from "../packages/vinext/src/shims/navigation.js";

describe("next/root-params shim", () => {
  it("resolves to undefined when called outside of root params scope", async () => {
    const val = await getRootParam("lang");
    expect(val).toBeUndefined();
  });

  it("resolves to the correct param within runWithRootParamsScope", async () => {
    const result = await runWithRootParamsScope({ lang: "en", locale: "en-US" }, async () => {
      const langVal = await getRootParam("lang");
      const localeVal = await getRootParam("locale");
      const missingVal = await getRootParam("missing");
      return { langVal, localeVal, missingVal };
    });

    expect(result).toEqual({
      langVal: "en",
      localeVal: "en-US",
      missingVal: undefined,
    });
  });

  it("supports nested scopes overriding outer scopes", async () => {
    const result = await runWithRootParamsScope({ lang: "en" }, async () => {
      const outer = await getRootParam("lang");
      const inner = await runWithRootParamsScope({ lang: "es" }, async () => getRootParam("lang"));
      const outerAfter = await getRootParam("lang");
      return { outer, inner, outerAfter };
    });

    expect(result).toEqual({
      outer: "en",
      inner: "es",
      outerAfter: "en",
    });
  });

  it("rejects access inside server actions", () => {
    try {
      void runWithRootParamsUsage({ kind: "server-action" }, () => getRootParam("lang"));
      throw new Error("Expected root params access to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: "Error",
        message:
          "`import('next/root-params').lang()` was used inside a Server Action. This is not supported. Functions from 'next/root-params' can only be called in the context of a route.",
      });
    }
  });

  it("rejects access inside route handlers", () => {
    expect(() =>
      runWithRootParamsUsage(
        { kind: "route-handler", routePattern: "/[lang]/[locale]/route-handler" },
        () => getRootParam("lang"),
      ),
    ).toThrow(
      "Route /[lang]/[locale]/route-handler used `import('next/root-params').lang()` inside a Route Handler. Support for this API in Route Handlers is planned for a future version of Next.js.",
    );
  });

  it("restores route access after restricted execution", async () => {
    await runWithRootParamsScope({ lang: "en" }, async () => {
      expect(() =>
        runWithRootParamsUsage({ kind: "server-action" }, () => getRootParam("lang")),
      ).toThrow();
      await expect(getRootParam("lang")).resolves.toBe("en");
    });
  });

  it("allows deferred work after a server action transitions to rendering", async () => {
    await runWithRootParamsScope({ lang: "en" }, async () => {
      const controller = createRootParamsUsageController();
      let resolveDeferred!: () => void;
      const deferred = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
      });
      let postActionRead!: Promise<string | string[] | undefined>;
      await runWithRootParamsUsage(
        { kind: "server-action" },
        async () => {
          postActionRead = deferred.then(() => getRootParam("lang"));
        },
        controller,
      );

      controller.transitionToRender();
      resolveDeferred();
      await expect(postActionRead).resolves.toBe("en");
    });
  });

  it("keeps deferred work restricted when a server action does not rerender", async () => {
    await runWithRootParamsScope({ lang: "en" }, async () => {
      let resolveDeferred!: () => void;
      const deferred = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
      });
      let postActionRead!: Promise<string | string[] | undefined>;
      await runWithRootParamsUsage({ kind: "server-action" }, async () => {
        postActionRead = deferred.then(() => getRootParam("lang"));
      });

      resolveDeferred();
      await expect(postActionRead).rejects.toThrow("was used inside a Server Action");
    });
  });

  it("isolates concurrent action cleanup", async () => {
    await runWithRootParamsScope({ lang: "en" }, async () => {
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = runWithRootParamsUsage({ kind: "server-action" }, async () => {
        await firstGate;
        return getRootParam("lang");
      });

      await expect(
        Promise.resolve().then(() =>
          runWithRootParamsUsage({ kind: "server-action" }, () => getRootParam("lang")),
        ),
      ).rejects.toThrow("was used inside a Server Action");
      releaseFirst();
      await expect(first).rejects.toThrow("was used inside a Server Action");
      await expect(getRootParam("lang")).resolves.toBe("en");
    });
  });

  it("integrates correctly with unified request context", async () => {
    const ctx = createRequestContext({ rootParams: { lang: "fr" } });
    const result = await runWithRequestContext(ctx, async () => {
      const langVal = await getRootParam("lang");

      // Nested overriding scope inside unified context
      const nestedVal = await runWithRootParamsScope({ lang: "de" }, async () =>
        getRootParam("lang"),
      );

      const langValAfter = await getRootParam("lang");

      return { langVal, nestedVal, langValAfter };
    });

    expect(result).toEqual({
      langVal: "fr",
      nestedVal: "de",
      langValAfter: "fr",
    });
  });

  it("proves sibling standalone state survives runWithRootParamsScope", async () => {
    await runWithNavigationContext(async () => {
      setNavigationContext({
        pathname: "/blog/en",
        searchParams: new URLSearchParams(),
        params: { lang: "en" },
      });

      await runWithRootParamsScope({ lang: "en" }, async () => {
        expect(getNavigationContext()?.pathname).toBe("/blog/en");
        await expect(getRootParam("lang")).resolves.toBe("en");
      });
    });
  });
});
