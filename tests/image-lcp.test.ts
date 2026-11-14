import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// See the browser port of Next.js's next-image-lcp-duplicate-src regression.
describe("image LCP diagnostics", () => {
  let report: (list: PerformanceObserverEntryList) => void;
  const observe = vi.fn();
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    observe.mockReset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("window", {
      PerformanceObserver: class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe = observe;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function image(loading: string | null) {
    return { getAttribute: vi.fn(() => loading) } as unknown as HTMLImageElement;
  }
  function paint(element: HTMLImageElement | null) {
    report({ getEntries: () => [{ element }] } as unknown as PerformanceObserverEntryList);
  }

  it("warns for a lazy painted element even when an eager duplicate shares its src", async () => {
    const { registerImageLcp } = await import("../packages/vinext/src/shims/image-lcp.js");
    const hero = image("lazy");
    registerImageLcp(hero, "/hero.png", "empty");
    registerImageLcp(image("eager"), "/hero.png", "empty");
    paint(hero);
    paint(hero);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Image with src "/hero.png" was detected as the Largest Contentful Paint (LCP)',
      ),
    );
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ type: "largest-contentful-paint", buffered: true });
  });

  it.each(["eager", null])(
    "does not warn for loading=%s with a lazy duplicate",
    async (loading) => {
      const { registerImageLcp } = await import("../packages/vinext/src/shims/image-lcp.js");
      const hero = image(loading);
      registerImageLcp(hero, "/hero.png", "empty");
      registerImageLcp(image("lazy"), "/hero.png", "empty");
      paint(hero);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["data:image/png;base64,abc", "empty"],
    ["blob:example", "empty"],
    ["/hero.png", "blur"],
    ["/hero.png", "data:image/png;base64,abc"],
  ])("excludes %s with placeholder %s", async (src, placeholder) => {
    const { registerImageLcp } = await import("../packages/vinext/src/shims/image-lcp.js");
    const hero = image("lazy");
    registerImageLcp(hero, src, placeholder);
    paint(hero);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores non-Image elements and entries without elements", async () => {
    const { registerImageLcp } = await import("../packages/vinext/src/shims/image-lcp.js");
    registerImageLcp(image("lazy"), "/hero.png", undefined);
    paint(image("lazy"));
    paint(null);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not observe in production or without browser support", async () => {
    const { registerImageLcp } = await import("../packages/vinext/src/shims/image-lcp.js");
    vi.stubEnv("NODE_ENV", "production");
    registerImageLcp(image("lazy"), "/hero.png", undefined);
    expect(observe).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.stubGlobal("window", {});
    expect(() => registerImageLcp(image("lazy"), "/hero.png", undefined)).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(() => registerImageLcp(image("lazy"), "/hero.png", undefined)).not.toThrow();
  });
});
