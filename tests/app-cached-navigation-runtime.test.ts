import { describe, expect, it } from "vite-plus/test";
import {
  resolveCachedNavigationRuntimeModuleChain,
  resolveCachedNavigationRuntimeRenderAction,
  routeUsesRuntimeCachedNavigations,
} from "../packages/vinext/src/server/app-cached-navigation-runtime.js";

describe("cached-navigation runtime branch eligibility", () => {
  const runtimeModule = { unstable_instant: { prefetch: "runtime" } };

  it("propagates opt-in downward without enabling ancestors or sibling branches", () => {
    expect(resolveCachedNavigationRuntimeModuleChain([{}, runtimeModule, {}])).toEqual([
      false,
      true,
      true,
    ]);
    expect(resolveCachedNavigationRuntimeModuleChain([{}])).toEqual([false]);
    expect(resolveCachedNavigationRuntimeModuleChain([{}], true)).toEqual([true]);
  });

  it("detects a slot-only runtime opt-in without requiring the page branch", () => {
    expect(
      routeUsesRuntimeCachedNavigations({
        layouts: [{}],
        page: {},
        slots: {
          children: {
            configLayouts: [runtimeModule],
            page: {},
          },
        },
      }),
    ).toBe(true);
  });

  it("uses only the active slot interception branch for runtime opt-in", () => {
    expect(
      routeUsesRuntimeCachedNavigations({
        layouts: [{}],
        page: {},
        slots: {
          modal: {
            intercepts: [
              {
                interceptLayouts: [{}],
                page: runtimeModule,
              },
            ],
          },
        },
      }),
    ).toBe(false);
    expect(
      routeUsesRuntimeCachedNavigations(
        {
          slots: {
            modal: {
              intercepts: [{ interceptLayouts: [{}], page: {} }],
            },
          },
        },
        { interceptLayouts: [runtimeModule], interceptPage: {} },
      ),
    ).toBe(true);
  });

  it("uses only the active sibling interception branch for runtime opt-in", () => {
    expect(
      routeUsesRuntimeCachedNavigations({
        layouts: [{}],
        page: {},
        siblingIntercepts: [
          {
            interceptLayouts: [runtimeModule],
            page: {},
          },
        ],
      }),
    ).toBe(false);
    expect(
      routeUsesRuntimeCachedNavigations(
        {
          siblingIntercepts: [{ interceptLayouts: [{}], page: {} }],
        },
        { interceptLayouts: [{}], interceptPage: runtimeModule },
      ),
    ).toBe(true);
  });

  it("suspends separate non-opted entries and omits combined-branch ancestors", () => {
    expect(
      resolveCachedNavigationRuntimeRenderAction({
        eligible: false,
        omitWhenDisabled: false,
        stage: "runtime",
      }),
    ).toBe("suspend");
    expect(
      resolveCachedNavigationRuntimeRenderAction({
        eligible: false,
        omitWhenDisabled: true,
        stage: "runtime",
      }),
    ).toBe("omit");
    expect(
      resolveCachedNavigationRuntimeRenderAction({
        eligible: true,
        omitWhenDisabled: false,
        stage: "runtime",
      }),
    ).toBe("render");
  });
});
