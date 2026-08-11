import { describe, expect, it } from "vite-plus/test";
import {
  APP_RSC_RENDER_MODE_CACHED_NAVIGATION_RUNTIME_STAGE,
  APP_RSC_RENDER_MODE_CACHED_NAVIGATION_STATIC_STAGE,
  APP_RSC_RENDER_MODE_NAVIGATION,
  getRscRenderModeCacheVariant,
  parseAppRscRenderMode,
  type AppRscRenderMode,
} from "../packages/vinext/src/server/app-rsc-render-mode.js";

describe("cached-navigation RSC render modes", () => {
  it.each<AppRscRenderMode>([
    APP_RSC_RENDER_MODE_CACHED_NAVIGATION_STATIC_STAGE,
    APP_RSC_RENDER_MODE_CACHED_NAVIGATION_RUNTIME_STAGE,
  ])("parses the %s transport value", (mode) => {
    expect(parseAppRscRenderMode(mode)).toBe(mode);
    expect(getRscRenderModeCacheVariant(mode)).toBe(mode);
  });

  it("falls back to an ordinary navigation for unknown transport values", () => {
    expect(parseAppRscRenderMode("cached-navigation-unknown")).toBe(APP_RSC_RENDER_MODE_NAVIGATION);
  });
});
