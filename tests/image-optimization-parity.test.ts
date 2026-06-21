import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR, startFixtureServer } from "./helpers.js";
import {
  createRuntimeImageConfig,
  getWorkerRemoteImageRedirect,
  getImageCacheControl,
  getImageContentDisposition,
  handleImageOptimization,
  imageOptimizationPathAfterBasePath,
  negotiateImageFormat,
  parseImageParams,
  parseRemoteImageUrl,
  isImageOptimizationPath,
  type ImageConfig,
} from "../packages/vinext/src/server/image-optimization.js";
import { fetchRemoteImageFromValidatedAddresses } from "../packages/vinext/src/server/node-remote-image-fetch.js";
import {
  getLocalImageLookupPath,
  startProdServer,
} from "../packages/vinext/src/server/prod-server.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);

const REMOTE_CONFIG: ImageConfig = {
  remotePatterns: [{ protocol: "https", hostname: "images.example.com", pathname: "/allowed/**" }],
  maximumRedirects: 1,
  maximumResponseBody: PNG_1X1.byteLength,
};

it("recognizes configured image paths with optional trailing slashes", () => {
  expect(isImageOptimizationPath("/docs/_next/image", "/docs/_next/image/")).toBe(true);
  expect(isImageOptimizationPath("/docs/_next/image/", "/docs/_next/image/")).toBe(true);
  expect(isImageOptimizationPath("/_next/image", "/docs/_next/image/")).toBe(false);
  expect(isImageOptimizationPath("/_vinext/image", "/docs/_next/image/")).toBe(false);
  expect(isImageOptimizationPath("/other/image", "/docs/_next/image/")).toBe(false);
});

it("recognizes the basePath-prefixed default optimizer route", () => {
  expect(isImageOptimizationPath("/docs/_next/image", "/docs/_next/image")).toBe(true);
  expect(isImageOptimizationPath("/unrelated/_next/image", "/docs/_next/image")).toBe(false);
});

it("normalizes configured image paths into the stripped basePath routing space", () => {
  expect(imageOptimizationPathAfterBasePath("/docs/_next/image/", "/docs")).toBe("/_next/image/");
  expect(imageOptimizationPathAfterBasePath("/_next/image", "/docs")).toBe("/_next/image");
});

it("preserves the configured image path in runtime config", () => {
  expect(createRuntimeImageConfig({ path: "/docs/_next/image/" })?.path).toBe("/docs/_next/image/");
});

it("preserves loader identity in runtime image config", () => {
  expect(createRuntimeImageConfig({ loader: "custom", unoptimized: true })).toMatchObject({
    loader: "custom",
    unoptimized: true,
  });
});

it.each([
  { imageConfig: { unoptimized: true }, label: "unoptimized images" },
  { imageConfig: { loader: "custom" as const }, label: "a custom loader" },
])("returns 404 for Node production optimizer requests with $label", async ({ imageConfig }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-image-disabled-prod-"));
  const serverDir = path.join(root, "server");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.mkdir(path.join(root, "client"), { recursive: true });
  await fs.writeFile(
    path.join(serverDir, "index.js"),
    `export const __assetPrefix = "";
export const __basePath = "";
export const __inlineCss = false;
export const __hasPagesDir = false;
export async function seedMemoryCacheFromPrerender() { return 0; }
export default async function handler() { return new Response("fallback", { status: 418 }); }`,
  );
  await fs.writeFile(path.join(serverDir, "image-config.json"), JSON.stringify(imageConfig));
  const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir: root });
  const server = "server" in started ? started.server : started;

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/_next/image?url=%2Fimg.jpg&w=640&q=75`,
    );
    expect(response.status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function startImagePathProdServer(router: "app" | "pages") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-${router}-image-path-prod-`));
  const serverDir = path.join(root, "server");
  const clientDir = path.join(root, "client");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.writeFile(path.join(clientDir, "img.png"), PNG_1X1);

  const imageConfig = {
    path: "/docs/custom-image/",
    loader: "default",
    deviceSizes: [640],
    imageSizes: [],
    qualities: [75],
  };
  if (router === "app") {
    await fs.writeFile(
      path.join(serverDir, "index.js"),
      `export const __assetPrefix = "";
export const __basePath = "/docs";
export const __inlineCss = false;
export const __hasPagesDir = false;
export async function seedMemoryCacheFromPrerender() { return 0; }
export default async function handler() { return new Response("fallback", { status: 418 }); }`,
    );
    await fs.writeFile(path.join(serverDir, "image-config.json"), JSON.stringify(imageConfig));
  } else {
    await fs.writeFile(
      path.join(serverDir, "entry.js"),
      `export const vinextConfig = ${JSON.stringify({ basePath: "/docs", images: imageConfig })};
export async function renderPage() { return new Response("fallback", { status: 418 }); }
export async function handleApiRoute() { return new Response("fallback", { status: 418 }); }
export async function runMiddleware() { return null; }`,
    );
  }

  const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir: root });
  const server = "server" in started ? started.server : started;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return { root, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

it.each(["app", "pages"] as const)(
  "%s Node production matches custom trailing-slash image paths inside basePath only",
  async (router) => {
    const fixture = await startImagePathProdServer(router);
    try {
      const optimized = await fetch(
        `${fixture.baseUrl}/docs/custom-image/?url=%2Fimg.png&w=640&q=75`,
      );
      expect(optimized.status).toBe(200);
      expect(Buffer.from(await optimized.arrayBuffer())).toEqual(PNG_1X1);

      const unprefixed = await fetch(`${fixture.baseUrl}/custom-image/?url=%2Fimg.png&w=640&q=75`, {
        redirect: "manual",
      });
      expect(unprefixed.status).not.toBe(200);
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

it("strips query parameters only for local production filesystem lookup", () => {
  expect(getLocalImageLookupPath("/images/hero.png?v=1")).toBe("/images/hero.png");
});

function remoteOptimizerRequest(source: string): Request {
  const url = new URL("http://vinext.test/_next/image");
  url.searchParams.set("url", source);
  url.searchParams.set("w", "64");
  url.searchParams.set("q", "75");
  return new Request(url);
}

function remoteHandlers(
  fetchRemote: (url: URL, addresses: readonly string[], signal: AbortSignal) => Promise<Response>,
  resolveHostnames: (hostname: string) => Promise<string[]> = async () => ["8.8.8.8"],
) {
  return {
    fetchAsset: async () => new Response(null, { status: 404 }),
    fetchRemote,
    resolveHostnames,
  };
}

function requestInputUrl(input: URL): string {
  return input.href;
}

describe("remote image URL parsing", () => {
  it.each([
    ["HTTP://images.example.com/test.png", "http://images.example.com/test.png"],
    ["HTTPS://images.example.com/test.png", "https://images.example.com/test.png"],
  ])("normalizes mixed-case HTTP(S) URLs: %s", (source, expected) => {
    expect(parseRemoteImageUrl(source)?.href).toBe(expected);
  });
});

describe("local image URL patterns", () => {
  it("rejects query-bearing local URLs by default", () => {
    const request = new URL(
      "http://vinext.test/_next/image?url=%2Fimages%2Fhero.png%3Fv%3D1&w=64&q=75",
    );
    expect(parseImageParams(request, [64], [75])).toBeNull();
  });

  it("allows explicitly matched local URLs with queries", () => {
    const request = new URL(
      "http://vinext.test/_next/image?url=%2Fimages%2Fhero.png%3Fv%3D1&w=64&q=75",
    );
    expect(
      parseImageParams(request, [64], [75], {
        localPatterns: [{ pathname: "/images/**", search: "?v=1" }],
      }),
    ).toEqual({ imageUrl: "/images/hero.png?v=1", width: 64, quality: 75 });
  });
});

describe("remote next/image endpoint security", () => {
  it("fetches an allowed remote image through the real optimizer handler", async () => {
    const requestedUrls: string[] = [];
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(async (input) => {
        requestedUrls.push(requestInputUrl(input));
        return new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });
      }),
      [64],
      REMOTE_CONFIG,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_1X1);
    expect(requestedUrls).toEqual(["https://images.example.com/allowed/test.png"]);
  });

  it("binds every Node fetch and redirect to validated DNS addresses", async () => {
    const requestedHosts: string[] = [];
    const server = createServer((request, response) => {
      requestedHosts.push(request.headers.host ?? "");
      if (request.url === "/allowed/start.png") {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Image server closed");
        response.writeHead(302, {
          Location: `http://cdn.example.net:${address.port}/final.png`,
        });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PNG_1X1);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Image test server failed");

    const resolvedHosts: string[] = [];
    try {
      const response = await handleImageOptimization(
        remoteOptimizerRequest(`HTTP://images.example.com:${address.port}/allowed/start.png`),
        remoteHandlers(fetchRemoteImageFromValidatedAddresses, async (hostname) => {
          resolvedHosts.push(hostname);
          return ["127.0.0.1"];
        }),
        [64],
        {
          ...REMOTE_CONFIG,
          remotePatterns: [
            { protocol: "http", hostname: "images.example.com", pathname: "/allowed/**" },
          ],
          dangerouslyAllowLocalIP: true,
        },
      );

      expect(response.status).toBe(200);
      expect(resolvedHosts).toEqual(["images.example.com", "cdn.example.net"]);
      expect(requestedHosts).toEqual([
        `images.example.com:${address.port}`,
        `cdn.example.net:${address.port}`,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not reuse a pooled socket after a hostname resolves to a different address", async () => {
    const firstServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end("first");
    });
    await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
    const firstAddress = firstServer.address();
    if (!firstAddress || typeof firstAddress === "string") throw new Error("Image server failed");

    const secondServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end("second");
    });
    await new Promise<void>((resolve, reject) => {
      secondServer.once("error", reject);
      secondServer.listen(firstAddress.port, "::1", () => {
        secondServer.off("error", reject);
        resolve();
      });
    });

    try {
      const url = new URL(`http://images.example.com:${firstAddress.port}/image.png`);
      const first = await fetchRemoteImageFromValidatedAddresses(
        url,
        ["127.0.0.1"],
        AbortSignal.timeout(1_000),
      );
      expect(await first.text()).toBe("first");

      const second = await fetchRemoteImageFromValidatedAddresses(
        url,
        ["::1"],
        AbortSignal.timeout(1_000),
      );
      expect(await second.text()).toBe("second");
    } finally {
      await Promise.all(
        [firstServer, secondServer].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    }
  });

  it("returns a controlled timeout when a remote body stalls after headers", async () => {
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(PNG_1X1.subarray(0, 1));
              },
              async pull(controller) {
                await new Promise((resolve) => setTimeout(resolve, 1));
                controller.error(new DOMException("body timed out", "TimeoutError"));
              },
            }),
            { headers: { "Content-Type": "image/png" } },
          ),
      ),
      [64],
      REMOTE_CONFIG,
    );

    expect(response.status).toBe(504);
    expect(await response.text()).toBe("Remote image request timed out");
  });

  it.each(["AbortError", "TimeoutError"])(
    "returns 504 when remote headers never arrive with %s",
    async (errorName) => {
      const response = await handleImageOptimization(
        remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
        remoteHandlers(async () => {
          throw new DOMException("headers timed out", errorName);
        }),
        [64],
        REMOTE_CONFIG,
      );

      expect(response.status).toBe(504);
      expect(await response.text()).toBe("Remote image request timed out");
    },
  );

  it("accepts public IPv6 literals without DNS and rejects private IPv6 literals", async () => {
    const resolvedHosts: string[] = [];
    const fetchedAddresses: (readonly string[])[] = [];
    const handlers = remoteHandlers(
      async (_url, addresses) => {
        fetchedAddresses.push(addresses);
        return new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });
      },
      async (hostname) => {
        resolvedHosts.push(hostname);
        return ["8.8.8.8"];
      },
    );

    const publicResponse = await handleImageOptimization(
      remoteOptimizerRequest("https://[2606:4700:4700::1111]/image.png"),
      handlers,
      [64],
      { ...REMOTE_CONFIG, domains: ["[2606:4700:4700::1111]"], remotePatterns: [] },
    );
    const privateResponse = await handleImageOptimization(
      remoteOptimizerRequest("https://[fc00::1]/image.png"),
      handlers,
      [64],
      { ...REMOTE_CONFIG, domains: ["[fc00::1]"], remotePatterns: [] },
    );
    const linkLocalResponse = await handleImageOptimization(
      remoteOptimizerRequest("https://[fe80::1]/image.png"),
      handlers,
      [64],
      { ...REMOTE_CONFIG, domains: ["[fe80::1]"], remotePatterns: [] },
    );

    expect(publicResponse.status).toBe(200);
    expect(privateResponse.status).toBe(400);
    expect(linkLocalResponse.status).toBe(400);
    expect(resolvedHosts).toEqual([]);
    expect(fetchedAddresses).toEqual([["2606:4700:4700::1111"]]);
  });

  it("does not forward remote response headers outside the image allowlist", async () => {
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(
        async () =>
          new Response(PNG_1X1, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=60",
              "Set-Cookie": "session=attacker; Path=/; HttpOnly",
              "Content-Encoding": "gzip",
              "Content-Length": String(PNG_1X1.byteLength),
              "X-Upstream-Secret": "do-not-forward",
            },
          }),
      ),
      [64],
      REMOTE_CONFIG,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=14400, must-revalidate");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-upstream-secret")).toBeNull();
  });

  it("rejects unconfigured hosts and credentials before fetching", async () => {
    let fetchCount = 0;
    const fetchRemote = async () => {
      fetchCount++;
      return new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });
    };

    for (const source of [
      "https://other.example.com/allowed/test.png",
      "https://user:pass@images.example.com/allowed/test.png",
    ]) {
      const response = await handleImageOptimization(
        remoteOptimizerRequest(source),
        remoteHandlers(fetchRemote),
        [64],
        REMOTE_CONFIG,
      );
      expect(response.status).toBe(400);
    }
    expect(fetchCount).toBe(0);
  });

  it("rejects literal, resolved, and redirect-to-private targets", async () => {
    const privateConfig: ImageConfig = {
      ...REMOTE_CONFIG,
      remotePatterns: [
        ...REMOTE_CONFIG.remotePatterns!,
        { protocol: "https", hostname: "127.0.0.1", pathname: "/**" },
      ],
    };

    const literal = await handleImageOptimization(
      remoteOptimizerRequest("https://127.0.0.1/test.png"),
      remoteHandlers(async () => new Response(PNG_1X1)),
      [64],
      privateConfig,
    );
    expect(literal.status).toBe(400);

    const resolved = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(
        async () => new Response(PNG_1X1),
        async () => ["10.0.0.8"],
      ),
      [64],
      REMOTE_CONFIG,
    );
    expect(resolved.status).toBe(400);

    const redirected = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(async () => Response.redirect("https://127.0.0.1/private.png", 302)),
      [64],
      privateConfig,
    );
    expect(redirected.status).toBe(400);

    const redirectedUrls: string[] = [];
    const redirectedToUnconfiguredHost = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(async (input) => {
        const url = requestInputUrl(input);
        redirectedUrls.push(url);
        return new URL(url).hostname === "images.example.com"
          ? Response.redirect("https://cdn.example.net/test.png", 302)
          : new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });
      }),
      [64],
      REMOTE_CONFIG,
    );
    expect(redirectedToUnconfiguredHost.status).toBe(200);
    expect(redirectedUrls).toEqual([
      "https://images.example.com/allowed/test.png",
      "https://cdn.example.net/test.png",
    ]);
  });

  it("fails closed without DNS validation and rejects literal private IPs", async () => {
    let fetchCount = 0;
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      {
        fetchAsset: async () => new Response(null, { status: 404 }),
        fetchRemote: async () => {
          fetchCount++;
          return new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });
        },
      },
      [64],
      REMOTE_CONFIG,
    );

    expect(response.status).toBe(400);
    expect(fetchCount).toBe(0);

    const privateResponse = await handleImageOptimization(
      remoteOptimizerRequest("https://127.0.0.1/test.png"),
      {
        fetchAsset: async () => new Response(null, { status: 404 }),
        fetchRemote: async () => {
          fetchCount++;
          return new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });
        },
      },
      [64],
      {
        ...REMOTE_CONFIG,
        remotePatterns: [{ protocol: "https", hostname: "127.0.0.1", pathname: "/**" }],
      },
    );

    expect(privateResponse.status).toBe(400);
    expect(fetchCount).toBe(0);
  });

  it("redirects configured Worker remote images without proxying them", () => {
    const response = getWorkerRemoteImageRedirect(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      [64],
      REMOTE_CONFIG,
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe("https://images.example.com/allowed/test.png");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("honors dangerouslyAllowLocalIP for configured Worker remote images", () => {
    const config: ImageConfig = {
      ...REMOTE_CONFIG,
      dangerouslyAllowLocalIP: true,
      remotePatterns: [{ protocol: "https", hostname: "127.0.0.1", pathname: "/**" }],
    };
    const response = getWorkerRemoteImageRedirect(
      remoteOptimizerRequest("https://127.0.0.1/test.png"),
      [64],
      config,
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe("https://127.0.0.1/test.png");
  });

  it.each([false, true])(
    "redirects mixed-case Worker remote URLs when dangerouslyAllowLocalIP is %s",
    (dangerouslyAllowLocalIP) => {
      const response = getWorkerRemoteImageRedirect(
        remoteOptimizerRequest("HTTPS://images.example.com/allowed/test.png"),
        [64],
        { ...REMOTE_CONFIG, dangerouslyAllowLocalIP },
      );

      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe("https://images.example.com/allowed/test.png");
    },
  );

  it("rejects unsafe Worker remote redirects and ignores local image requests", () => {
    const unconfigured = getWorkerRemoteImageRedirect(
      remoteOptimizerRequest("https://other.example.com/test.png"),
      [64],
      REMOTE_CONFIG,
    );
    const privateTarget = getWorkerRemoteImageRedirect(
      remoteOptimizerRequest("https://127.0.0.1/test.png"),
      [64],
      {
        ...REMOTE_CONFIG,
        remotePatterns: [{ protocol: "https", hostname: "127.0.0.1", pathname: "/**" }],
      },
    );
    const localRequest = remoteOptimizerRequest("/public/test.png");

    expect(unconfigured?.status).toBe(400);
    expect(privateTarget?.status).toBe(400);
    expect(getWorkerRemoteImageRedirect(localRequest, [64], REMOTE_CONFIG)).toBeNull();
  });

  it("rejects remote fetching without validated DNS addresses", async () => {
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      {
        fetchAsset: async () => new Response(null, { status: 404 }),
        fetchRemote: async () =>
          new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } }),
      },
      [64],
      { ...REMOTE_CONFIG, dangerouslyAllowLocalIP: true },
    );

    expect(response.status).toBe(400);
  });

  it("caps redirects and response bodies", async () => {
    const redirectLoop = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(async (input) => Response.redirect(requestInputUrl(input), 302)),
      [64],
      REMOTE_CONFIG,
    );
    expect(redirectLoop.status).toBe(508);

    const oversized = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(
        async () =>
          new Response(Buffer.concat([PNG_1X1, Buffer.from([0])]), {
            headers: { "Content-Type": "image/png" },
          }),
      ),
      [64],
      REMOTE_CONFIG,
    );
    expect(oversized.status).toBe(413);
  });

  it("rejects unsafe remote content types", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("<html>not an image</html>"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(async () => new Response(body, { headers: { "Content-Type": "text/html" } })),
      [64],
      REMOTE_CONFIG,
    );

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });
});

describe("runtime image config projection", () => {
  it("preserves remote and security settings used by Pages Node production", () => {
    const config: ImageConfig = {
      deviceSizes: [320],
      imageSizes: [16],
      qualities: [60],
      formats: ["image/avif", "image/webp"],
      remotePatterns: [{ protocol: "https", hostname: "images.example.com" }],
      domains: ["legacy.example.com"],
      maximumRedirects: 2,
      maximumResponseBody: 1024,
      minimumCacheTTL: 300,
      dangerouslyAllowSVG: true,
      dangerouslyAllowLocalIP: true,
      contentDispositionType: "attachment",
      contentSecurityPolicy: "sandbox",
    };

    expect(createRuntimeImageConfig(config)).toEqual(config);
  });

  it("uses the Next.js quality and format defaults", () => {
    const request = new URL("http://vinext.test/_next/image?url=%2Fimage.png&w=640&q=75");
    expect(parseImageParams(request)).not.toBeNull();
    request.searchParams.set("q", "80");
    expect(parseImageParams(request)).toBeNull();

    expect(negotiateImageFormat("image/avif,image/webp")).toBe("image/webp");
    expect(negotiateImageFormat("image/avif,image/webp", ["image/avif", "image/webp"])).toBe(
      "image/avif",
    );
  });

  it("honors Accept qualities while preserving configured server preference", () => {
    const formats = ["image/avif", "image/webp"] as const;
    expect(negotiateImageFormat("image/avif;q=0.5,image/webp;q=0.9", formats)).toBe("image/webp");
    expect(negotiateImageFormat("image/webp,image/avif", formats)).toBe("image/avif");
    expect(negotiateImageFormat("image/avif;q=0,image/webp;q=0", formats)).toBe("");
    expect(negotiateImageFormat("image/avif;q=0,*/*;q=1", formats)).toBe("image/webp");
  });

  it("uses configured formats for runtime transformations", async () => {
    const transformedFormats: string[] = [];
    const handlers = {
      fetchAsset: async () => new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } }),
      transformImage: async (
        body: ReadableStream,
        options: { width: number; format: string; quality: number },
      ) => {
        await body.cancel();
        transformedFormats.push(options.format);
        return new Response(PNG_1X1, { headers: { "Content-Type": options.format } });
      },
    };
    const request = new Request("http://vinext.test/_next/image?url=%2Fimage.png&w=640&q=75", {
      headers: { Accept: "image/avif,image/webp" },
    });

    await handleImageOptimization(request, handlers);
    await handleImageOptimization(request, handlers, undefined, {
      formats: ["image/avif", "image/webp"],
    });

    expect(transformedFormats).toEqual(["image/webp", "image/avif"]);
  });

  it("shares standards-compliant local image Content-Disposition generation", () => {
    expect(getImageContentDisposition("/café.jpg", "image/png", "attachment")).toBe(
      'attachment; filename="café.png"',
    );
  });
});

describe("next/image cache control parity", () => {
  it("keeps hashed static imports immutable", () => {
    for (const imageUrl of [
      "/_next/static/media/hero.abc123.png",
      "/docs/_next/static/media/hero.abc123.png",
    ]) {
      expect(getImageCacheControl(imageUrl, "max-age=60", 300)).toBe(
        "public, max-age=315360000, immutable",
      );
    }
  });

  it("uses minimumCacheTTL for mutable public images", () => {
    expect(getImageCacheControl("/hero.png", "public, max-age=60", 300)).toBe(
      "public, max-age=300, must-revalidate",
    );
  });

  it("honors a longer upstream TTL for remote images", async () => {
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(
        async () =>
          new Response(PNG_1X1, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=60, s-maxage=900",
            },
          }),
      ),
      [64],
      { ...REMOTE_CONFIG, minimumCacheTTL: 300 },
    );

    expect(response.headers.get("cache-control")).toBe("public, max-age=900, must-revalidate");
  });

  it("disables mutable image caching in development", async () => {
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/test.png"),
      remoteHandlers(
        async () =>
          new Response(PNG_1X1, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=900",
            },
          }),
      ),
      [64],
      REMOTE_CONFIG,
      { isDev: true },
    );

    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("next/image response security header parity", () => {
  it("includes a standards-encoded, content-type-derived filename in Content-Disposition", async () => {
    const createResponse = (contentDispositionType?: "inline" | "attachment") =>
      handleImageOptimization(
        remoteOptimizerRequest("https://images.example.com/allowed/héllo world.jpg?version=1"),
        remoteHandlers(
          async () => new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } }),
        ),
        [64],
        { ...REMOTE_CONFIG, contentDispositionType },
      );

    expect((await createResponse()).headers.get("content-disposition")).toBe(
      'attachment; filename="héllo world.png"',
    );
    expect((await createResponse("inline")).headers.get("content-disposition")).toBe(
      'inline; filename="héllo world.png"',
    );
  });

  it("uses an extended filename for characters outside ISO-8859-1", async () => {
    const response = await handleImageOptimization(
      remoteOptimizerRequest("https://images.example.com/allowed/日本語.jpg"),
      remoteHandlers(
        async () => new Response(PNG_1X1, { headers: { "Content-Type": "image/jpeg" } }),
      ),
      [64],
      REMOTE_CONFIG,
    );

    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"???.jpeg\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.jpeg",
    );
  });
});

async function createImageFixture(router: "app" | "pages"): Promise<string> {
  const baseFixtureDir = router === "app" ? APP_FIXTURE_DIR : PAGES_FIXTURE_DIR;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-${router}-image-parity-`));
  await fs.cp(baseFixtureDir, rootDir, { recursive: true });
  try {
    await fs.access(path.join(rootDir, "node_modules"));
  } catch {
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(rootDir, "node_modules"),
      "junction",
    );
  }
  await fs.mkdir(path.join(rootDir, "public"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "public", "äöüščří.png"), PNG_1X1);
  await fs.writeFile(path.join(rootDir, "public", "hello world.png"), PNG_1X1);
  const configPath = path.join(rootDir, router === "app" ? "next.config.ts" : "next.config.mjs");
  const configSource = await fs.readFile(configPath, "utf8");
  const updatedConfigSource =
    router === "app"
      ? configSource.replace(
          'remotePatterns: [{ protocol: "http", hostname: "127.0.0.1", port: "4199" }],',
          'remotePatterns: [{ protocol: "http", hostname: "localhost", pathname: "/**" }],',
        )
      : configSource.replace(
          "const nextConfig = {",
          `const nextConfig = {
  images: {
    remotePatterns: [{ protocol: "http", hostname: "localhost", pathname: "/**" }],
    dangerouslyAllowLocalIP: true,
  },`,
        );
  await fs.writeFile(configPath, updatedConfigSource);

  if (router === "app") {
    await fs.rm(path.join(rootDir, "app", "alias-test"), { recursive: true, force: true });
    await fs.rm(path.join(rootDir, "app", "baseurl-test"), { recursive: true, force: true });
    await fs.mkdir(path.join(rootDir, "app", "image-parity"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "app", "image-parity", "page.tsx"),
      `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <Image alt="unicode" src="/äöüščří.png" width={64} height={64} />
      <Image alt="space" src="/hello world.png" width={64} height={64} />
    </main>
  );
}
`,
    );
  } else {
    await fs.mkdir(path.join(rootDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "pages", "image-parity.tsx"),
      `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <Image alt="unicode" src="/äöüščří.png" width={64} height={64} />
      <Image alt="space" src="/hello world.png" width={64} height={64} />
    </main>
  );
}
`,
    );
  }

  return rootDir;
}

function getImageSrcFromHtml(html: string, alt: string): string {
  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = match[0];
    if (!tag.includes(`alt="${alt}"`)) continue;
    const srcMatch = tag.match(/\ssrc="([^"]+)"/);
    if (srcMatch) return srcMatch[1].replaceAll("&amp;", "&");
  }

  throw new Error(`Could not find <img> tag for alt="${alt}"`);
}

async function fetchHtmlWithRetry(baseUrl: string, pagePath: string): Promise<string> {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${baseUrl}${pagePath}`);
    const body = await res.text();
    if (res.status === 200) return body;
    lastStatus = res.status;
    lastBody = body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Expected ${pagePath} to return 200, got ${lastStatus}: ${lastBody.slice(0, 500)}`,
  );
}

function runLocalImageUrlParitySuite(router: "app" | "pages"): void {
  describe(`${router === "app" ? "App" : "Pages"} Router next/image local URL parity`, () => {
    let server: ViteDevServer;
    let baseUrl: string;
    let fixtureDir: string;
    let remoteImageServer: ReturnType<typeof createServer>;
    let remoteImagePort: number;

    beforeAll(async () => {
      remoteImageServer = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(PNG_1X1);
      });
      await new Promise<void>((resolve) => remoteImageServer.listen(0, "127.0.0.1", resolve));
      const remoteAddress = remoteImageServer.address();
      if (!remoteAddress || typeof remoteAddress === "string") {
        throw new Error("Remote image fixture failed to start");
      }
      remoteImagePort = remoteAddress.port;
      fixtureDir = await createImageFixture(router);
      ({ server, baseUrl } = await startFixtureServer(fixtureDir, { appRouter: router === "app" }));
    }, 30000);

    afterAll(async () => {
      await server?.close();
      await new Promise<void>((resolve, reject) =>
        remoteImageServer?.close((error) => (error ? reject(error) : resolve())),
      );
      await fs.rm(fixtureDir, { recursive: true, force: true });
    });

    // Ported from Next.js: test/integration/next-image-new/unicode/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/unicode/test/index.test.ts
    it("serves internal unicode image URLs through the optimizer route", async () => {
      const pagePath = "/image-parity";
      const html = await fetchHtmlWithRetry(baseUrl, pagePath);
      const src = getImageSrcFromHtml(html, "unicode");
      const imageUrl = new URL(src, baseUrl);

      expect(imageUrl.pathname).toBe("/_next/image");
      expect(imageUrl.searchParams.get("url")).toBe("/äöüščří.png");
      expect(imageUrl.searchParams.get("w")).toBe("128");
      expect(imageUrl.searchParams.get("q")).toBe("75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    });

    // Ported from Next.js: test/integration/next-image-new/unicode/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/unicode/test/index.test.ts
    it("serves internal image URLs with spaces through the optimizer route", async () => {
      const pagePath = "/image-parity";
      const html = await fetchHtmlWithRetry(baseUrl, pagePath);
      const src = getImageSrcFromHtml(html, "space");
      const imageUrl = new URL(src, baseUrl);

      expect(imageUrl.pathname).toBe("/_next/image");
      expect(imageUrl.searchParams.get("url")).toBe("/hello world.png");
      expect(imageUrl.searchParams.get("w")).toBe("128");
      expect(imageUrl.searchParams.get("q")).toBe("75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    });

    it("optimizes mixed-case remote HTTP URLs", async () => {
      const imageUrl = new URL("/_next/image", baseUrl);
      imageUrl.searchParams.set("url", `HTTP://localhost:${remoteImagePort}/remote.png`);
      imageUrl.searchParams.set("w", "64");
      imageUrl.searchParams.set("q", "75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    });
  });
}

runLocalImageUrlParitySuite("app");
runLocalImageUrlParitySuite("pages");
