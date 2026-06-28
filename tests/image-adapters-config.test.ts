/**
 * Config-driven image optimizer tests.
 *
 * Covers:
 *  - generateImageAdaptersModule() codegen for the `virtual:vinext-image-adapters`
 *    module across the no-config / configured permutations, including inlined
 *    descriptor options and the double-registration guard.
 *  - The image optimizer registry in server/image-optimization.ts
 *    (setImageOptimizer / getImageOptimizer / handleConfiguredImageOptimization).
 *  - The Cloudflare image optimizer: its config-time builder (imagesOptimizer) and its
 *    runtime factory default export.
 *  - Registration wiring into the Pages worker entry + App Router RSC entry image
 *    config exports.
 */
import path from "node:path";
import { describe, it, expect, afterEach } from "vite-plus/test";
import {
  generateImageAdaptersModule,
  VIRTUAL_IMAGE_ADAPTERS,
} from "../packages/vinext/src/image/image-adapters-virtual.js";
import {
  setImageOptimizer,
  getImageOptimizer,
  handleConfiguredImageOptimization,
  type ImageOptimizer,
} from "../packages/vinext/src/server/image-optimization.js";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { generatePagesRouterWorkerEntry } from "../packages/vinext/src/init-cloudflare.js";
import { imagesOptimizer } from "../packages/cloudflare/src/images/images-optimizer.js";
import createCloudflareImageOptimizer from "../packages/cloudflare/src/images/images-optimizer.runtime.js";

describe("generateImageAdaptersModule", () => {
  it("exposes the public virtual module id", () => {
    expect(VIRTUAL_IMAGE_ADAPTERS).toBe("virtual:vinext-image-adapters");
  });

  it("emits a no-op registrar when no optimizer is configured", () => {
    for (const images of [undefined, {}, { optimizer: undefined }]) {
      const code = generateImageAdaptersModule(images);
      expect(code).toContain("export function registerConfiguredImageOptimizer() {}");
      expect(code).not.toContain("import");
      expect(code).not.toContain("setImageOptimizer");
    }
  });

  it("wires the optimizer when configured", () => {
    const code = generateImageAdaptersModule({ optimizer: { adapter: "my-image-adapter" } });
    expect(code).toContain(`import __vinextImageOptimizerFactory from "my-image-adapter";`);
    expect(code).toContain(`import { setImageOptimizer } from "vinext/server/image-optimization";`);
    expect(code).toContain(
      "setImageOptimizer(__vinextImageOptimizerFactory({ env, options: undefined }));",
    );
  });

  it("inlines descriptor options and forwards them to the factory", () => {
    const code = generateImageAdaptersModule({
      optimizer: {
        adapter: "@vinext/cloudflare/images/images-optimizer",
        options: { binding: "MY_IMAGES" },
      },
    });
    expect(code).toContain(
      `setImageOptimizer(__vinextImageOptimizerFactory({ env, options: {"binding":"MY_IMAGES"} }));`,
    );
  });

  it("guards against double registration", () => {
    const code = generateImageAdaptersModule({
      optimizer: { adapter: "@vinext/cloudflare/images/images-optimizer" },
    });
    expect(code).toContain("if (__vinextImageOptimizerRegistered) return;");
    expect(code).toContain("__vinextImageOptimizerRegistered = true;");
  });

  it("escapes adapter specifiers so absolute paths are safe", () => {
    const weird = `/tmp/some path/with"quote/adapter.js`;
    const code = generateImageAdaptersModule({ optimizer: { adapter: weird } });
    expect(code).toContain(`import __vinextImageOptimizerFactory from ${JSON.stringify(weird)};`);
  });
});

describe("image optimizer registry", () => {
  afterEach(() => setImageOptimizer(null));

  it("returns null when no optimizer is registered", () => {
    setImageOptimizer(null);
    expect(getImageOptimizer()).toBeNull();
  });

  it("stores and retrieves the active optimizer", () => {
    const optimizer: ImageOptimizer = { transformImage: async () => new Response("x") };
    setImageOptimizer(optimizer);
    expect(getImageOptimizer()).toBe(optimizer);
  });

  it("handleConfiguredImageOptimization transforms via the registered optimizer", async () => {
    let transformCalled = false;
    setImageOptimizer({
      transformImage: async (_body, { width, format }) => {
        transformCalled = true;
        return new Response("optimized", {
          status: 200,
          headers: { "Content-Type": format, "X-Width": String(width) },
        });
      },
    });

    const fetchAsset = async () =>
      new Response("source-bytes", { status: 200, headers: { "Content-Type": "image/png" } });

    const request = new Request("https://example.com/_next/image?url=%2Ffoo.png&w=640&q=75", {
      headers: { Accept: "image/webp" },
    });
    const response = await handleConfiguredImageOptimization(request, fetchAsset, [640]);

    expect(transformCalled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });

  it("preserves `this` for an optimizer implemented as a class instance", async () => {
    class ClassOptimizer implements ImageOptimizer {
      private readonly label = "from-class";
      async transformImage(_body: ReadableStream, { format }: { format: string }) {
        // Reads an instance field: throws if transformImage is ever invoked
        // detached from the instance (the regression fixed in
        // handleConfiguredImageOptimization).
        return new Response(this.label, {
          status: 200,
          headers: { "Content-Type": format },
        });
      }
    }
    setImageOptimizer(new ClassOptimizer());

    const fetchAsset = async () =>
      new Response("source-bytes", { status: 200, headers: { "Content-Type": "image/png" } });
    const request = new Request("https://example.com/_next/image?url=%2Ffoo.png&w=640&q=75", {
      headers: { Accept: "image/webp" },
    });
    const response = await handleConfiguredImageOptimization(request, fetchAsset, [640]);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from-class");
  });

  it("serves the original (passthrough) when no optimizer is registered", async () => {
    setImageOptimizer(null);
    const fetchAsset = async () =>
      new Response("source-bytes", { status: 200, headers: { "Content-Type": "image/png" } });

    const request = new Request("https://example.com/_next/image?url=%2Ffoo.png&w=640&q=75");
    const response = await handleConfiguredImageOptimization(request, fetchAsset, [640]);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("source-bytes");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });
});

describe("imagesOptimizer builder", () => {
  it("resolves the runtime factory to an absolute path without touching the Workers runtime", () => {
    const descriptor = imagesOptimizer({ binding: "MY_IMAGES" });
    expect(path.isAbsolute(descriptor.adapter)).toBe(true);
    expect(descriptor.adapter.endsWith("images-optimizer.runtime.js")).toBe(true);
    expect(descriptor.options).toEqual({ binding: "MY_IMAGES" });
    expect(imagesOptimizer().options).toBeUndefined();
  });

  it("validates the binding option at config time", () => {
    // @ts-expect-error — binding must be a string
    expect(() => imagesOptimizer({ binding: 123 })).toThrow(/binding/);
  });
});

describe("Cloudflare image-adapter factory", () => {
  function makeImagesBinding(record: { width?: unknown; format?: string; quality?: number }) {
    return {
      input(_stream: ReadableStream) {
        return {
          transform(opts: Record<string, unknown>) {
            record.width = opts.width;
            return {
              async output(out: { format: string; quality: number }) {
                record.format = out.format;
                record.quality = out.quality;
                return { response: () => new Response("transformed", { status: 200 }) };
              },
            };
          },
        };
      },
    };
  }

  it("returns an optimizer bound to the default IMAGES binding", async () => {
    const record: { width?: unknown; format?: string; quality?: number } = {};
    const optimizer = createCloudflareImageOptimizer({
      env: { IMAGES: makeImagesBinding(record) },
      options: undefined,
    });
    const body = new Response("x").body!;
    const res = await optimizer.transformImage(body, {
      width: 640,
      format: "image/webp",
      quality: 80,
    });
    expect(res.status).toBe(200);
    expect(record.width).toBe(640);
    expect(record.format).toBe("image/webp");
    expect(record.quality).toBe(80);
  });

  it("omits width from the transform when width is 0 (no resize)", async () => {
    const record: { width?: unknown } = { width: "unset" };
    const optimizer = createCloudflareImageOptimizer({
      env: { IMAGES: makeImagesBinding(record) },
      options: undefined,
    });
    await optimizer.transformImage(new Response("x").body!, {
      width: 0,
      format: "image/jpeg",
      quality: 75,
    });
    expect(record.width).toBeUndefined();
  });

  it("honors a custom binding name from descriptor options", async () => {
    const record: { width?: unknown } = {};
    const optimizer = createCloudflareImageOptimizer({
      env: { MY_IMAGES: makeImagesBinding(record) },
      options: { binding: "MY_IMAGES" },
    });
    const res = await optimizer.transformImage(new Response("x").body!, {
      width: 100,
      format: "image/avif",
      quality: 50,
    });
    expect(res.status).toBe(200);
  });

  it("throws a helpful error when the configured binding is missing", () => {
    expect(() => createCloudflareImageOptimizer({ env: {}, options: undefined })).toThrow(/IMAGES/);
    expect(() =>
      createCloudflareImageOptimizer({ env: { OTHER: {} }, options: { binding: "MY_IMAGES" } }),
    ).toThrow(/`MY_IMAGES` Images binding/);
    expect(() => createCloudflareImageOptimizer({ env: undefined, options: undefined })).toThrow(
      /Images binding/,
    );
  });
});

describe("registration is wired into the router/runtime entries", () => {
  const minimalAppRoutes = [
    {
      pattern: "/",
      patternParts: [],
      pagePath: "/tmp/test/app/page.tsx",
      routePath: null,
      layouts: ["/tmp/test/app/layout.tsx"],
      templates: [],
      parallelSlots: [],
      loadingPath: null,
      errorPath: null,
      layoutErrorPaths: [null],
      notFoundPath: null,
      notFoundPaths: [null],
      forbiddenPaths: [null],
      forbiddenPath: null,
      unauthorizedPaths: [null],
      unauthorizedPath: null,
      routeSegments: [],
      templateTreePositions: [],
      layoutTreePositions: [0],
      isDynamic: false,
      params: [],
    },
  ] as unknown as Parameters<typeof generateRscEntry>[1];

  it("App Router RSC entry inlines image allowed-widths + config for the worker entry", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false, {
      imageConfig: {
        deviceSizes: [320, 640],
        imageSizes: [16, 32],
        qualities: [75, 90],
        dangerouslyAllowSVG: true,
      },
    });
    expect(code).toContain("export const __imageAllowedWidths =");
    expect(code).toContain("export const __imageConfig =");
    // deviceSizes + imageSizes union, in order.
    expect(code).toContain("[320,640,16,32]");
    expect(code).toContain('"dangerouslyAllowSVG":true');
    expect(code).toContain('"qualities":[75,90]');
  });

  it("App Router RSC entry falls back to Next.js default widths when images is unset", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);
    // Next.js defaults: deviceSizes then imageSizes.
    expect(code).toContain("[640,750,828,1080,1200,1920,2048,3840,16,32,48,64,96,128,256,384]");
  });

  it("Pages Router worker entry registers the optimizer with env and uses the registry", () => {
    const code = generatePagesRouterWorkerEntry();
    expect(code).toContain('from "virtual:vinext-image-adapters"');
    expect(code).toContain("registerConfiguredImageOptimizer(env)");
    expect(code).toContain("handleConfiguredImageOptimization(");
    // No longer wires the Cloudflare Images binding inline.
    expect(code).not.toContain("env.IMAGES");
  });
});
