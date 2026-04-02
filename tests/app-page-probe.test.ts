import { describe, expect, it, vi } from "vite-plus/test";
import { probeAppPageBeforeRender } from "../packages/vinext/src/server/app-page-probe.js";

describe("app page probe helpers", () => {
  it("handles layout special errors before probing the page", async () => {
    const layoutError = new Error("layout failed");
    const pageProbe = vi.fn(() => "page");
    const renderLayoutSpecialError = vi.fn(
      async () => new Response("layout-fallback", { status: 404 }),
    );
    const renderPageSpecialError = vi.fn();
    const probedLayouts: number[] = [];

    const response = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 3,
      probeLayoutAt(layoutIndex) {
        probedLayouts.push(layoutIndex);
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      probePage: pageProbe,
      renderLayoutSpecialError,
      renderPageSpecialError,
      resolveSpecialError(error) {
        return error === layoutError
          ? {
              kind: "http-access-fallback",
              statusCode: 404,
            }
          : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(probedLayouts).toEqual([2, 1]);
    expect(pageProbe).not.toHaveBeenCalled();
    expect(renderLayoutSpecialError).toHaveBeenCalledWith(
      {
        kind: "http-access-fallback",
        statusCode: 404,
      },
      1,
    );
    expect(renderPageSpecialError).not.toHaveBeenCalled();
    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("layout-fallback");
  });

  it("falls through to the page probe when layout failures are not special", async () => {
    const layoutError = new Error("ordinary layout failure");
    const pageProbe = vi.fn(() => null);
    const renderLayoutSpecialError = vi.fn();

    const response = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 2,
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      probePage: pageProbe,
      renderLayoutSpecialError,
      renderPageSpecialError() {
        throw new Error("should not render a page special error");
      },
      resolveSpecialError() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(response).toBeNull();
    expect(pageProbe).toHaveBeenCalledTimes(1);
    expect(renderLayoutSpecialError).not.toHaveBeenCalled();
  });

  it("turns special page probe failures into immediate responses", async () => {
    const pageError = new Error("page failed");
    const renderPageSpecialError = vi.fn(
      async () => new Response("page-fallback", { status: 307 }),
    );

    const response = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 0,
      probeLayoutAt() {
        throw new Error("should not probe layouts");
      },
      probePage() {
        return Promise.reject(pageError);
      },
      renderLayoutSpecialError() {
        throw new Error("should not render a layout special error");
      },
      renderPageSpecialError,
      resolveSpecialError(error) {
        return error === pageError
          ? {
              kind: "redirect",
              location: "/target",
              statusCode: 307,
            }
          : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(renderPageSpecialError).toHaveBeenCalledWith({
      kind: "redirect",
      location: "/target",
      statusCode: 307,
    });
    expect(response?.status).toBe(307);
    await expect(response?.text()).resolves.toBe("page-fallback");
  });

  it("does not await async page probes when a loading boundary is present", async () => {
    const renderPageSpecialError = vi.fn();

    const response = await probeAppPageBeforeRender({
      hasLoadingBoundary: true,
      layoutCount: 0,
      probeLayoutAt() {
        throw new Error("should not probe layouts");
      },
      probePage() {
        return Promise.reject(new Error("late page failure"));
      },
      renderLayoutSpecialError() {
        throw new Error("should not render a layout special error");
      },
      renderPageSpecialError,
      resolveSpecialError() {
        return {
          kind: "http-access-fallback",
          statusCode: 404,
        };
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(response).toBeNull();
    expect(renderPageSpecialError).not.toHaveBeenCalled();
  });
});
