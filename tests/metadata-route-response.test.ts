import { describe, expect, it } from "vite-plus/test";
import { handleMetadataRouteRequest } from "../packages/vinext/src/server/metadata-route-response.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";

type MetadataRuntimeRoute = MetadataFileRoute & {
  fileDataBase64?: string;
};

function makeThenableParams(params: Record<string, string | string[]>): unknown {
  return Object.assign(Promise.resolve(params), params);
}

describe("handleMetadataRouteRequest", () => {
  it("does not inspect generateSitemaps on non-sitemap metadata routes", async () => {
    let generateSitemapsReads = 0;
    const route = {
      type: "icon",
      isDynamic: true,
      filePath: "/tmp/app/icon.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon",
      contentType: "image/png",
      module: {
        get generateSitemaps() {
          generateSitemapsReads++;
          return () => [];
        },
        default: () => new Response("icon", { headers: { "Content-Type": "image/png" } }),
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(generateSitemapsReads).toBe(0);
  });

  it("serves matched static metadata route file data", async () => {
    const route = {
      type: "icon",
      isDynamic: false,
      filePath: "/tmp/app/icon.png",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon.png",
      contentType: "image/png",
      fileDataBase64: btoa("icon-bytes"),
    } satisfies MetadataRuntimeRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon.png",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(
      Array.from(new Uint8Array((await response?.arrayBuffer()) ?? new ArrayBuffer(0))),
    ).toEqual([105, 99, 111, 110, 45, 98, 121, 116, 101, 115]);
  });

  it("caches metadata route module function lookups", async () => {
    let generateImageMetadataReads = 0;
    const route = {
      type: "icon",
      isDynamic: true,
      filePath: "/tmp/app/icon.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon",
      contentType: "image/png",
      module: {
        get generateImageMetadata() {
          generateImageMetadataReads++;
          return () => [{ id: "small" }];
        },
        default: () => new Response("icon"),
      },
    } satisfies MetadataFileRoute;

    const firstResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/small",
      makeThenableParams,
    });
    const secondResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/small",
      makeThenableParams,
    });

    expect(firstResponse?.status).toBe(200);
    expect(secondResponse?.status).toBe(200);
    expect(generateImageMetadataReads).toBe(1);
  });

  it("checks generateSitemaps once when skipping the generated sitemap base URL", async () => {
    let generateSitemapsReads = 0;
    const route = {
      type: "sitemap",
      isDynamic: true,
      filePath: "/tmp/app/products/sitemap.ts",
      routePrefix: "/products",
      routeSegments: ["products"],
      servedUrl: "/products/sitemap.xml",
      contentType: "application/xml",
      module: {
        get generateSitemaps() {
          generateSitemapsReads++;
          return () => [{ id: 0 }];
        },
        default: () => [{ url: "https://example.com/products/0" }],
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/products/sitemap.xml",
      makeThenableParams,
    });

    expect(response).toBeNull();
    expect(generateSitemapsReads).toBe(1);
  });

  it("passes generated sitemap id as a thenable URL string id", async () => {
    let receivedPromise = false;
    let receivedSyncId: string | undefined;
    let receivedPrimitiveId: string | undefined;
    const route = {
      type: "sitemap",
      isDynamic: true,
      filePath: "/tmp/app/products/sitemap.ts",
      routePrefix: "/products",
      routeSegments: ["products"],
      servedUrl: "/products/sitemap.xml",
      contentType: "application/xml",
      module: {
        generateSitemaps: () => [{ id: 0 }],
        default: async ({
          id,
        }: {
          id: Promise<string | undefined> & {
            toString(): string;
            [Symbol.toPrimitive](): string;
          };
        }) => {
          receivedPromise = id instanceof Promise;
          receivedSyncId = id.toString();
          receivedPrimitiveId = String(id);
          return [{ url: `https://example.com/products/${await id}` }];
        },
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/products/sitemap/0.xml",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(receivedPromise).toBe(true);
    expect(receivedSyncId).toBe("0");
    expect(receivedPrimitiveId).toBe("0");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(await response?.text()).toContain("https://example.com/products/0");
  });

  it("throws when matched static metadata route data is missing", async () => {
    const route = {
      type: "icon",
      isDynamic: false,
      filePath: "/tmp/app/icon.png",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon.png",
      contentType: "image/png",
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/icon.png",
        makeThenableParams,
      }),
    ).rejects.toThrow("Static metadata route /icon.png is missing embedded file data");
  });

  it("throws when matched static metadata route data is corrupt", async () => {
    const route = {
      type: "icon",
      isDynamic: false,
      filePath: "/tmp/app/icon.png",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon.png",
      contentType: "image/png",
      fileDataBase64: "%%%",
    } satisfies MetadataRuntimeRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/icon.png",
        makeThenableParams,
      }),
    ).rejects.toThrow("Failed to decode embedded metadata route file data for /icon.png");
  });

  it("sets explicit cache control on generated metadata route responses", async () => {
    const route = {
      type: "robots",
      isDynamic: true,
      filePath: "/tmp/app/robots.ts",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/robots.txt",
      contentType: "text/plain",
      module: {
        default: () => ({ rules: { userAgent: "*" } }),
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/robots.txt",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("throws the route contract error when robots returns an array", async () => {
    const route = {
      type: "robots",
      isDynamic: true,
      filePath: "/tmp/app/robots.ts",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/robots.txt",
      contentType: "text/plain",
      module: {
        default: () => [],
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/robots.txt",
        makeThenableParams,
      }),
    ).rejects.toThrow("Metadata robots routes must return an object.");
  });

  it("throws the route contract error when manifest returns an array", async () => {
    const route = {
      type: "manifest",
      isDynamic: true,
      filePath: "/tmp/app/manifest.ts",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/manifest.webmanifest",
      contentType: "application/manifest+json",
      module: {
        default: () => [],
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/manifest.webmanifest",
        makeThenableParams,
      }),
    ).rejects.toThrow("Metadata manifest routes must return an object.");
  });

  it("throws when generateSitemaps returns an entry without id", async () => {
    const route = {
      type: "sitemap",
      isDynamic: true,
      filePath: "/tmp/app/products/sitemap.ts",
      routePrefix: "/products",
      routeSegments: ["products"],
      servedUrl: "/products/sitemap.xml",
      contentType: "application/xml",
      module: {
        generateSitemaps: () => [{}],
        default: () => [{ url: "https://example.com/products/0" }],
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/products/sitemap/0.xml",
        makeThenableParams,
      }),
    ).rejects.toThrow("id property is required for every item returned from generateSitemaps");
  });

  it("serves dynamic generated image metadata routes by matched id", async () => {
    let receivedId: Promise<string | undefined> | null = null;
    let receivedSyncId: string | undefined;
    let receivedSlug: string | undefined;
    const route = {
      type: "opengraph-image",
      isDynamic: true,
      filePath: "/tmp/app/blog/[slug]/opengraph-image.tsx",
      routePrefix: "/blog/[slug]",
      routeSegments: ["blog", "[slug]"],
      servedUrl: "/blog/[slug]/opengraph-image",
      patternParts: ["blog", ":slug", "opengraph-image"],
      contentType: "image/png",
      module: {
        generateImageMetadata: async ({ params }: { params: Promise<{ slug: string }> }) => [
          { id: `${(await params).slug}-small` },
        ],
        default: async ({
          id,
          params,
        }: {
          id: Promise<string | undefined> & { toString(): string };
          params: Promise<{ slug: string }> & { slug?: string };
        }) => {
          receivedId = id;
          receivedSyncId = id.toString();
          receivedSlug = params.slug;
          return new Response(`image:${await id}`, {
            headers: { "Content-Type": "image/png" },
          });
        },
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/blog/post/opengraph-image/post-small",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(receivedId).toBeInstanceOf(Promise);
    expect(receivedSyncId).toBe("post-small");
    expect(receivedSlug).toBe("post");
    expect(await response?.text()).toBe("image:post-small");
  });

  it("returns 404 for unknown or invalid generated image ids", async () => {
    const route = {
      type: "icon",
      isDynamic: true,
      filePath: "/tmp/app/icon.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon",
      contentType: "image/png",
      module: {
        generateImageMetadata: async () => [{ id: "small" }],
        default: () => new Response("icon"),
      },
    } satisfies MetadataFileRoute;

    const unknownResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/large",
      makeThenableParams,
    });
    const invalidResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/bad/id",
      makeThenableParams,
    });

    expect(unknownResponse?.status).toBe(404);
    expect(invalidResponse).toBeNull();
  });

  it("throws when dynamic image metadata routes return non-Response values", async () => {
    const route = {
      type: "opengraph-image",
      isDynamic: true,
      filePath: "/tmp/app/opengraph-image.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/opengraph-image",
      contentType: "image/png",
      module: {
        default: () => ({ broken: true }),
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/opengraph-image",
        makeThenableParams,
      }),
    ).rejects.toThrow(
      "Dynamic metadata opengraph-image route /opengraph-image must return a Response.",
    );
  });
});
