import { describe, expect, it, vi } from "vite-plus/test";
import { applyFileBasedMetadata } from "../packages/vinext/src/server/file-based-metadata.js";
import type { Metadata } from "../packages/vinext/src/shims/metadata.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";

const ogHeadData = {
  kind: "openGraph",
  href: "/blog/opengraph-image.png?hash",
  type: "image/png",
  width: 1200,
  height: 630,
} as const;

describe("applyFileBasedMetadata", () => {
  it("preserves URL metadata values while injecting file metadata", async () => {
    const metadata: Metadata = {
      metadataBase: new URL("https://example.com"),
    };
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/app/icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon.png",
        contentType: "image/png",
        headData: {
          kind: "icon",
          href: "/icon.png?hash",
          type: "image/png",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(metadata, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata }],
    });

    expect(result?.metadataBase).toBe(metadata.metadataBase);
    expect(result?.icons).toEqual({
      icon: [{ url: "/icon.png?hash", sizes: "32x32", type: "image/png" }],
    });
  });

  it("keeps explicit icon and apple metadata ahead of file icon routes", async () => {
    const metadata: Metadata = {
      icons: {
        apple: "/manual-apple.png",
        icon: "/manual-icon.png",
      },
    };
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/app/icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon.png",
        contentType: "image/png",
        headData: {
          kind: "icon",
          href: "/icon.png?hash",
          type: "image/png",
          sizes: "32x32",
        },
      },
      {
        type: "apple-icon",
        isDynamic: false,
        filePath: "/tmp/app/apple-icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/apple-icon.png",
        contentType: "image/png",
        headData: {
          kind: "apple",
          href: "/apple-icon.png?hash",
          type: "image/png",
          sizes: "180x180",
        },
      },
    ];

    const result = await applyFileBasedMetadata(metadata, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata }],
    });

    expect(result?.icons).toEqual({
      apple: "/manual-apple.png",
      icon: "/manual-icon.png",
    });
  });

  it("keeps explicit shorthand icon metadata ahead of file icon routes", async () => {
    const metadata: Metadata = { icons: "/manual-icon.png" };
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/app/icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon.png",
        contentType: "image/png",
        headData: {
          kind: "icon",
          href: "/icon.png?hash",
          type: "image/png",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(metadata, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata }],
    });

    expect(result?.icons).toBe("/manual-icon.png");
  });

  it("keeps inherited explicit icon metadata ahead of leaf file icon routes", async () => {
    const parentMetadata: Metadata = { icons: "/parent-icon.png" };
    const leafMetadata: Metadata = { title: "Leaf" };
    const mergedMetadata: Metadata = { icons: "/parent-icon.png", title: "Leaf" };
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/app/blog/icon.png",
        routePrefix: "/blog",
        routeSegments: ["blog"],
        servedUrl: "/blog/icon.png",
        contentType: "image/png",
        headData: {
          kind: "icon",
          href: "/blog/icon.png?hash",
          type: "image/png",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(mergedMetadata, "/blog", {}, routes, {
      routeSegments: ["blog"],
      metadataSources: [
        { routeSegments: [], metadata: parentMetadata },
        { routeSegments: ["blog"], metadata: leafMetadata },
      ],
    });

    expect(result?.icons).toBe("/parent-icon.png");
  });

  it("preserves explicit shorthand icon metadata when prepending a favicon", async () => {
    const metadata: Metadata = { icons: "/manual-icon.png" };
    const routes: MetadataFileRoute[] = [
      {
        type: "favicon",
        isDynamic: false,
        filePath: "/tmp/app/favicon.ico",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/favicon.ico",
        contentType: "image/x-icon",
        headData: {
          kind: "favicon",
          href: "/favicon.ico?hash",
          type: "image/x-icon",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(metadata, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata }],
    });

    expect(result?.icons).toEqual({
      icon: [
        { url: "/favicon.ico?hash", sizes: "32x32", type: "image/x-icon" },
        { url: "/manual-icon.png" },
      ],
    });
  });

  it("preserves explicit descriptor icon metadata when prepending a favicon", async () => {
    const metadata: Metadata = {
      icons: { url: "/manual-icon.png", sizes: "64x64", type: "image/png" },
    };
    const routes: MetadataFileRoute[] = [
      {
        type: "favicon",
        isDynamic: false,
        filePath: "/tmp/app/favicon.ico",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/favicon.ico",
        contentType: "image/x-icon",
        headData: {
          kind: "favicon",
          href: "/favicon.ico?hash",
          type: "image/x-icon",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(metadata, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata }],
    });

    expect(result?.icons).toEqual({
      icon: [
        { url: "/favicon.ico?hash", sizes: "32x32", type: "image/x-icon" },
        { url: "/manual-icon.png", sizes: "64x64", type: "image/png" },
      ],
    });
  });

  it("lets a leaf file image replace inherited parent Open Graph images", async () => {
    const parentMetadata: Metadata = {
      openGraph: {
        description: "Parent description",
        images: ["/parent-og.png"],
        siteName: "Parent site",
        title: "Parent title",
        type: "article",
      },
    };
    const leafMetadata: Metadata = { title: "Blog" };
    const mergedMetadata: Metadata = {
      title: "Blog",
      openGraph: {
        description: "Parent description",
        images: ["/parent-og.png"],
        siteName: "Parent site",
        title: "Parent title",
        type: "article",
      },
    };
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/blog/opengraph-image.png",
        routePrefix: "/blog",
        routeSegments: ["blog"],
        servedUrl: "/blog/opengraph-image.png",
        contentType: "image/png",
        headData: ogHeadData,
      },
    ];

    const result = await applyFileBasedMetadata(mergedMetadata, "/blog", {}, routes, {
      routeSegments: ["blog"],
      metadataSources: [
        { routeSegments: [], metadata: parentMetadata },
        { routeSegments: ["blog"], metadata: leafMetadata },
      ],
    });

    expect(result?.openGraph?.images).toEqual([
      { url: "/blog/opengraph-image.png?hash", type: "image/png", width: 1200, height: 630 },
    ]);
    expect(result?.openGraph?.description).toBe("Parent description");
    expect(result?.openGraph?.siteName).toBe("Parent site");
    expect(result?.openGraph?.title).toBe("Parent title");
    expect(result?.openGraph?.type).toBe("article");
  });

  it("keeps same-segment explicit Open Graph images ahead of file images", async () => {
    const leafMetadata: Metadata = { openGraph: { images: ["/manual-og.png"] } };
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/blog/opengraph-image.png",
        routePrefix: "/blog",
        routeSegments: ["blog"],
        servedUrl: "/blog/opengraph-image.png",
        contentType: "image/png",
        headData: ogHeadData,
      },
    ];

    const result = await applyFileBasedMetadata(leafMetadata, "/blog", {}, routes, {
      routeSegments: ["blog"],
      metadataSources: [
        { routeSegments: ["blog"], metadata: { title: "Blog layout" } },
        { routeSegments: ["blog"], metadata: leafMetadata },
      ],
    });

    expect(result?.openGraph?.images).toEqual(["/manual-og.png"]);
  });

  it("lets a leaf Twitter file image replace inherited parent Twitter images", async () => {
    const parentMetadata: Metadata = {
      twitter: {
        card: "summary_large_image",
        images: ["/parent-twitter.png"],
      },
    };
    const leafMetadata: Metadata = { title: "Blog" };
    const mergedMetadata: Metadata = {
      title: "Blog",
      twitter: {
        card: "summary_large_image",
        images: ["/parent-twitter.png"],
      },
    };
    const routes: MetadataFileRoute[] = [
      {
        type: "twitter-image",
        isDynamic: false,
        filePath: "/tmp/app/blog/twitter-image.png",
        routePrefix: "/blog",
        routeSegments: ["blog"],
        servedUrl: "/blog/twitter-image.png",
        contentType: "image/png",
        headData: {
          kind: "twitter",
          href: "/blog/twitter-image.png?hash",
          type: "image/png",
          width: 1200,
          height: 630,
          alt: "Twitter alt",
        },
      },
    ];

    const result = await applyFileBasedMetadata(mergedMetadata, "/blog", {}, routes, {
      routeSegments: ["blog"],
      metadataSources: [
        { routeSegments: [], metadata: parentMetadata },
        { routeSegments: ["blog"], metadata: leafMetadata },
      ],
    });

    expect(result?.twitter?.card).toBe("summary_large_image");
    expect(result?.twitter?.images).toEqual([
      {
        alt: "Twitter alt",
        height: 630,
        type: "image/png",
        url: "/blog/twitter-image.png?hash",
        width: 1200,
      },
    ]);
  });

  it("applies file manifest metadata over config manifest metadata", async () => {
    const metadata: Metadata = { manifest: "/manual.webmanifest" };
    const routes: MetadataFileRoute[] = [
      {
        type: "manifest",
        isDynamic: false,
        filePath: "/tmp/app/manifest.webmanifest",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/manifest.webmanifest",
        contentType: "application/manifest+json",
        headData: { kind: "manifest", href: "/manifest.webmanifest" },
      },
    ];

    const result = await applyFileBasedMetadata(metadata, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata }],
    });

    expect(result?.manifest).toBe("/manifest.webmanifest");
  });

  it("uses raw route segments so same-prefix route groups select their own file metadata", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/(marketing)/opengraph-image.png",
        routePrefix: "",
        routeSegments: ["(marketing)"],
        servedUrl: "/opengraph-image-marketing.png",
        contentType: "image/png",
        headData: { ...ogHeadData, href: "/opengraph-image-marketing.png?hash" },
      },
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/(shop)/opengraph-image.png",
        routePrefix: "",
        routeSegments: ["(shop)"],
        servedUrl: "/opengraph-image-shop.png",
        contentType: "image/png",
        headData: { ...ogHeadData, href: "/opengraph-image-shop.png?hash" },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/", {}, routes, {
      routeSegments: ["(marketing)"],
      metadataSources: [{ routeSegments: ["(marketing)"], metadata: null }],
    });

    expect(result?.openGraph?.images).toEqual([
      { url: "/opengraph-image-marketing.png?hash", type: "image/png", width: 1200, height: 630 },
    ]);
  });

  it("applies metadata from an active parallel slot page", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/parallel/@parallel/opengraph-image.png",
        routePrefix: "/parallel",
        routeSegments: ["parallel", "@parallel"],
        servedUrl: "/parallel/opengraph-image-slot.png",
        contentType: "image/png",
        headData: { ...ogHeadData, href: "/parallel/opengraph-image-slot.png?hash" },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/parallel", {}, routes, {
      routeSegments: ["parallel"],
      metadataSources: [{ routeSegments: ["parallel"], metadata: null }],
    });

    expect(result?.openGraph?.images).toEqual([
      {
        url: "/parallel/opengraph-image-slot.png?hash",
        type: "image/png",
        width: 1200,
        height: 630,
      },
    ]);
  });

  it("drops generateImageMetadata ids that are not path-segment safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/opengraph-image.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/opengraph-image",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async () => [{ id: "a/b" }],
        },
      },
    ];

    try {
      const result = await applyFileBasedMetadata(null, "/", {}, routes, {
        routeSegments: [],
        metadataSources: [{ routeSegments: [], metadata: null }],
      });

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[vinext] Skipping metadata route /opengraph-image image id "a/b" because metadata image ids must match /^[a-zA-Z0-9-_.]+$/.',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("drops generateImageMetadata entries without ids", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/opengraph-image.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/opengraph-image",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async () => [{ alt: "missing id" }],
        },
      },
    ];

    try {
      const result = await applyFileBasedMetadata(null, "/", {}, routes, {
        routeSegments: [],
        metadataSources: [{ routeSegments: [], metadata: null }],
      });

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "[vinext] Skipping metadata route /opengraph-image image metadata entry because generateImageMetadata entries must include an id.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("uses dynamic metadata module exports when generateImageMetadata is absent", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/blog/[slug]/opengraph-image.tsx",
        routePrefix: "/blog/[slug]",
        routeSegments: ["blog", "[slug]"],
        servedUrl: "/blog/[slug]/opengraph-image",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          alt: "Dynamic alt",
          contentType: "image/jpeg",
          size: { width: 640, height: 360 },
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/blog/post", { slug: "post" }, routes, {
      routeSegments: ["blog", "[slug]"],
      metadataSources: [{ routeSegments: ["blog", "[slug]"], metadata: null }],
    });

    expect(result?.openGraph?.images).toEqual([
      {
        alt: "Dynamic alt",
        height: 360,
        type: "image/jpeg",
        url: "/blog/post/opengraph-image?hash",
        width: 640,
      },
    ]);
  });

  it("passes thenable params with sync properties to generateImageMetadata", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/blog/[slug]/opengraph-image.tsx",
        routePrefix: "/blog/[slug]",
        routeSegments: ["blog", "[slug]"],
        servedUrl: "/blog/[slug]/opengraph-image",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async (props: {
            params: Promise<{ slug: string }> & { slug?: string };
          }) => [{ id: props.params.slug }],
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/blog/post", { slug: "post" }, routes, {
      routeSegments: ["blog", "[slug]"],
      metadataSources: [{ routeSegments: ["blog", "[slug]"], metadata: null }],
    });

    expect(result?.openGraph?.images).toEqual([
      {
        type: "image/png",
        url: "/blog/post/opengraph-image/post?hash",
      },
    ]);
  });

  it("injects multiple generateImageMetadata entries", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/opengraph-image.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/opengraph-image",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async () => [
            {
              id: "small",
              alt: "Small image",
              contentType: "image/jpeg",
              size: { width: 640, height: 360 },
            },
            {
              id: "large",
              alt: "Large image",
              contentType: "image/png",
              size: { width: 1200, height: 630 },
            },
          ],
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata: null }],
    });

    expect(result?.openGraph?.images).toEqual([
      {
        alt: "Small image",
        height: 360,
        type: "image/jpeg",
        url: "/opengraph-image/small?hash",
        width: 640,
      },
      {
        alt: "Large image",
        height: 630,
        type: "image/png",
        url: "/opengraph-image/large?hash",
        width: 1200,
      },
    ]);
  });

  it("drops dynamic metadata head URLs when params cannot fill servedUrl segments", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/blog/[slug]/icon.tsx",
        routePrefix: "/blog/[slug]",
        routeSegments: ["blog", "[slug]"],
        servedUrl: "/blog/[slug]/icon",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async () => [{ id: "small" }],
        },
      },
    ];

    try {
      const result = await applyFileBasedMetadata(null, "/blog/[slug]", {}, routes, {
        routeSegments: ["blog", "[slug]"],
        metadataSources: [{ routeSegments: ["blog", "[slug]"], metadata: null }],
      });

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "[vinext] Skipping metadata route /blog/[slug]/icon because params did not fill all dynamic segments.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("drops dynamic metadata head URLs when single segments receive multi-value params", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/blog/[slug]/icon.tsx",
        routePrefix: "/blog/[slug]",
        routeSegments: ["blog", "[slug]"],
        servedUrl: "/blog/[slug]/icon",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async () => [{ id: "small" }],
        },
      },
    ];

    try {
      const result = await applyFileBasedMetadata(
        null,
        "/blog/[slug]",
        { slug: ["a", "b"] },
        routes,
        {
          routeSegments: ["blog", "[slug]"],
          metadataSources: [{ routeSegments: ["blog", "[slug]"], metadata: null }],
        },
      );

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "[vinext] Skipping metadata route /blog/[slug]/icon because params did not fill all dynamic segments.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("drops required catch-all metadata head URLs when params contain no segments", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/docs/[...slug]/icon.tsx",
        routePrefix: "/docs/[...slug]",
        routeSegments: ["docs", "[...slug]"],
        servedUrl: "/docs/[...slug]/icon",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async () => [{ id: "small" }],
        },
      },
    ];

    try {
      const result = await applyFileBasedMetadata(null, "/docs/[...slug]", { slug: [] }, routes, {
        routeSegments: ["docs", "[...slug]"],
        metadataSources: [{ routeSegments: ["docs", "[...slug]"], metadata: null }],
      });

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "[vinext] Skipping metadata route /docs/[...slug]/icon because params did not fill all dynamic segments.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("skips empty optional catch-all metadata params instead of emitting empty URL segments", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/docs/[[...slug]]/icon.tsx",
        routePrefix: "/docs/[[...slug]]",
        routeSegments: ["docs", "[[...slug]]"],
        servedUrl: "/docs/[[...slug]]/icon",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata: async () => [{ id: "small" }],
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/docs", { slug: "" }, routes, {
      metadataSources: [{ routeSegments: ["docs"], metadata: null }],
    });

    expect(result?.icons).toEqual({
      icon: [{ type: "image/png", url: "/docs/icon/small?hash" }],
    });
  });
});
