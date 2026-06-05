import path from "node:path";
import { type ViteDevServer } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

describe("metadata routes integration (App Router)", () => {
  // These tests reuse the App Router dev server from the integration tests
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves /sitemap.xml from dynamic sitemap.ts", async () => {
    const res = await fetch(`${baseUrl}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<urlset");
    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain("https://example.com");
    expect(xml).toContain("https://example.com/about");
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr" />',
    );
    expect(xml).toContain("<image:loc>https://example.com/image.jpg</image:loc>");
    expect(xml).toContain("<video:title>Homepage Video</video:title>");
    expect(xml).toContain("<video:content_loc>https://example.com/video.mp4</video:content_loc>");
  });

  it("serves /robots.txt from dynamic robots.ts", async () => {
    const res = await fetch(`${baseUrl}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("User-Agent: *");
    expect(text).toContain("Allow: /");
    expect(text).toContain("Disallow: /private/");
    expect(text).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("serves /manifest.webmanifest from dynamic manifest.ts", async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const data = await res.json();
    expect(data.name).toBe("App Basic");
    expect(data.display).toBe("standalone");
  });

  it("serves sitemap routes that import but do not render client references", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    const res = await fetch(`${baseUrl}/client-ref-dependency/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
  });

  // Note: serving /icon from dynamic icon.tsx requires the RSC environment
  // to have access to Satori + Resvg Node APIs. This works when the RSC env
  // has proper Node externals configured. The discovery/routing is tested below.

  it("scanMetadataFiles discovers icon.tsx as a dynamic icon route", async () => {
    const { scanMetadataFiles } = await import("../packages/vinext/src/server/metadata-routes.js");
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);

    const iconRoute = routes.find(
      (r: { type: string; isDynamic: boolean }) => r.type === "icon" && r.isDynamic,
    );
    expect(iconRoute).toBeDefined();
    expect(iconRoute!.isDynamic).toBe(true);
    expect(iconRoute!.servedUrl).toBe("/icon");
    expect(iconRoute!.contentType).toBe("image/png");
  });

  it("scanMetadataFiles discovers static apple-icon.png at root", async () => {
    const { scanMetadataFiles } = await import("../packages/vinext/src/server/metadata-routes.js");
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);

    const appleIcon = routes.find((r: { type: string }) => r.type === "apple-icon");
    expect(appleIcon).toBeDefined();
    expect(appleIcon!.isDynamic).toBe(false);
    expect(appleIcon!.servedUrl).toBe("/apple-icon.png");
    expect(appleIcon!.contentType).toBe("image/png");
  });

  it("scanMetadataFiles discovers nested opengraph-image.png", async () => {
    const { scanMetadataFiles } = await import("../packages/vinext/src/server/metadata-routes.js");
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);

    const ogImage = routes.find(
      (r: { type: string; servedUrl: string }) =>
        r.type === "opengraph-image" && r.servedUrl === "/about/opengraph-image.png",
    );
    expect(ogImage).toBeDefined();
    expect(ogImage!.isDynamic).toBe(false);
    expect(ogImage!.contentType).toBe("image/png");
  });

  it("serves static /apple-icon.png as PNG with cache headers", async () => {
    const res = await fetch(`${baseUrl}/apple-icon.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const buf = await res.arrayBuffer();
    // Verify it's a valid PNG (starts with PNG magic bytes)
    const magic = new Uint8Array(buf.slice(0, 8));
    expect(magic[0]).toBe(0x89);
    expect(magic[1]).toBe(0x50); // P
    expect(magic[2]).toBe(0x4e); // N
    expect(magic[3]).toBe(0x47); // G
  });

  it("serves nested static /about/opengraph-image.png as PNG", async () => {
    const res = await fetch(`${baseUrl}/about/opengraph-image.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    const magic = new Uint8Array(buf.slice(0, 4));
    expect(magic[0]).toBe(0x89);
    expect(magic[1]).toBe(0x50);
  });

  it("injects file-based metadata into head tags for static metadata files", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-static-file/metadata-static-file-static-route.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-static-file/metadata-static-file-static-route.test.ts
    const res = await fetch(`${baseUrl}/metadata-static`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+href="[^"]*\/favicon\.ico(?:\?[^"]+)?"[^>]*>/);
    expect(html).toMatch(
      /<link[^>]+rel="apple-touch-icon"[^>]+href="[^"]*\/metadata-static\/apple-icon\.png(?:\?[^"]+)?"[^>]*>/,
    );
    expect(html).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/metadata-static\/icon\.png(?:\?[^"]+)?"[^>]*>/,
    );
    expect(html).toMatch(
      /<meta[^>]+property="og:image"[^>]+content="[^"]*\/metadata-static\/opengraph-image\.png(?:\?[^"]+)?"[^>]*>/,
    );
    expect(html).toMatch(
      /<meta[^>]+property="og:image:alt"[^>]+content="Static OG image alt text[^"]*"[^>]*>/,
    );
    expect(html).toMatch(
      /<meta[^>]+name="twitter:image"[^>]+content="[^"]*\/metadata-static\/twitter-image\.png(?:\?[^"]+)?"[^>]*>/,
    );
    expect(html).toMatch(
      /<meta[^>]+name="twitter:image:alt"[^>]+content="Static Twitter image alt text[^"]*"[^>]*>/,
    );
    expect(html).toMatch(/<link[^>]+rel="manifest"[^>]+href="[^"]*\/manifest\.webmanifest"[^>]*>/);
  });

  it("injects sizes=any for static SVG icon metadata routes", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-svg-icon/metadata-svg-icon.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-svg-icon/metadata-svg-icon.test.ts
    const res = await fetch(`${baseUrl}/metadata-svg-icon`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/metadata-svg-icon\/icon\.svg(?:\?[^"]+)?"[^>]+sizes="any"[^>]+type="image\/svg\+xml"[^>]*>/,
    );
  });

  it("renders icons.icon descriptor object metadata without crashing", async () => {
    const res = await fetch(`${baseUrl}/metadata-icons-object`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/metadata-icons-object\/object-icon\.png"[^>]+sizes="96x96"[^>]+type="image\/png"[^>]*>/,
    );
  });

  it("emits exactly one favicon link plus icons metadata shortcut/apple/other in root segment", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
    const res = await fetch(`${baseUrl}/metadata-icons-mix`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Exactly one favicon.ico link (no duplicates from icon merging or file-based metadata).
    const faviconMatches = html.match(/<link[^>]+href="[^"]*\/favicon\.ico(?:\?[^"]*)?"[^>]*>/g);
    expect(faviconMatches?.length ?? 0).toBe(1);

    // metadata.icons.shortcut emits rel="shortcut icon".
    expect(html).toMatch(/<link[^>]+rel="shortcut icon"[^>]+href="\/shortcut-icon\.png"[^>]*>/);

    // metadata.icons.apple emits rel="apple-touch-icon".
    expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"[^>]+href="\/apple-icon\.png"[^>]*>/);

    // metadata.icons.other emits a custom rel link.
    expect(html).toMatch(
      /<link[^>]+rel="apple-touch-icon-precomposed"[^>]+href="\/apple-touch-icon-precomposed\.png"[^>]*>/,
    );
  });

  it("emits exactly one favicon link plus nested icons metadata shortcut/apple/other on nested page", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
    const res = await fetch(`${baseUrl}/metadata-icons-mix/nested`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const faviconMatches = html.match(/<link[^>]+href="[^"]*\/favicon\.ico(?:\?[^"]*)?"[^>]*>/g);
    expect(faviconMatches?.length ?? 0).toBe(1);

    expect(html).toMatch(
      /<link[^>]+rel="shortcut icon"[^>]+href="\/shortcut-icon-nested\.png"[^>]*>/,
    );
    expect(html).toMatch(
      /<link[^>]+rel="apple-touch-icon"[^>]+href="\/apple-icon-nested\.png"[^>]*>/,
    );
    expect(html).toMatch(
      /<link[^>]+rel="apple-touch-icon-precomposed-nested"[^>]+href="\/apple-touch-icon-precomposed-nested\.png"[^>]*>/,
    );
  });

  it("injects dynamic metadata image routes into the head", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata/metadata.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts
    const homeRes = await fetch(`${baseUrl}/`);
    expect(homeRes.status).toBe(200);
    const homeHtml = await homeRes.text();
    expect(homeHtml).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/favicon\.ico(?:\?[^"]+)?"[^>]*>/,
    );
    expect(homeHtml).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/icon(?:\?[^"]+)?"[^>]+sizes="32x32"[^>]+type="image\/png"[^>]*>/,
    );

    const blogRes = await fetch(`${baseUrl}/blog/hello-world`);
    expect(blogRes.status).toBe(200);
    const blogHtml = await blogRes.text();
    expect(blogHtml).toMatch(
      /<meta[^>]+property="og:image"[^>]+content="[^"]*\/blog\/hello-world\/opengraph-image(?:\?[^"]+)?"[^>]*>/,
    );
    expect(blogHtml).toMatch(/<meta[^>]+property="og:image:width"[^>]+content="1200"[^>]*>/);
    expect(blogHtml).toMatch(/<meta[^>]+property="og:image:height"[^>]+content="630"[^>]*>/);
    expect(blogHtml).toMatch(/<meta[^>]+property="og:image:type"[^>]+content="image\/png"[^>]*>/);
    expect(blogHtml).toMatch(
      /<meta[^>]+property="og:image:alt"[^>]+content="Blog post open graph image"[^>]*>/,
    );
  });

  it("injects multiple generateImageMetadata icon routes into the head", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    const res = await fetch(`${baseUrl}/metadata-multi-image/big`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/metadata-multi-image\/big\/icon\/big-small(?:\?[^"]+)?"[^>]+sizes="48x48"[^>]+type="image\/png"[^>]*>/,
    );
    expect(html).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/metadata-multi-image\/big\/icon\/big-medium(?:\?[^"]+)?"[^>]+sizes="72x72"[^>]+type="image\/png"[^>]*>/,
    );
  });

  it("uses placeholder urls for static metadata files in dynamic segments", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-static-file/metadata-static-file-dynamic-route.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-static-file/metadata-static-file-dynamic-route.test.ts
    const res = await fetch(`${baseUrl}/metadata-dynamic-static/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toMatch(
      /<link[^>]+rel="apple-touch-icon"[^>]+href="[^"]*\/metadata-dynamic-static\/-\/apple-icon\.png(?:\?[^"]+)?"[^>]*>/,
    );
    expect(html).toMatch(
      /<link[^>]+rel="icon"[^>]+href="[^"]*\/metadata-dynamic-static\/-\/icon\.png(?:\?[^"]+)?"[^>]*>/,
    );
    expect(html).toMatch(
      /<meta[^>]+property="og:image"[^>]+content="[^"]*\/metadata-dynamic-static\/-\/opengraph-image\.png(?:\?[^"]+)?"[^>]*>/,
    );
    expect(html).toMatch(
      /<meta[^>]+name="twitter:image"[^>]+content="[^"]*\/metadata-dynamic-static\/-\/twitter-image\.png(?:\?[^"]+)?"[^>]*>/,
    );
  });

  it("scanMetadataFiles discovers static favicon.ico at root", async () => {
    const { scanMetadataFiles } = await import("../packages/vinext/src/server/metadata-routes.js");
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);

    const favicon = routes.find((r: { type: string }) => r.type === "favicon");
    expect(favicon).toBeDefined();
    expect(favicon!.isDynamic).toBe(false);
    expect(favicon!.servedUrl).toBe("/favicon.ico");
    expect(favicon!.contentType).toBe("image/x-icon");
  });

  it("serves static /favicon.ico with correct content type", async () => {
    const res = await fetch(`${baseUrl}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const buf = await res.arrayBuffer();
    // Verify it's a valid ICO file (starts with ICO magic bytes: 00 00 01 00)
    const magic = new Uint8Array(buf.slice(0, 4));
    expect(magic[0]).toBe(0x00);
    expect(magic[1]).toBe(0x00);
    expect(magic[2]).toBe(0x01);
    expect(magic[3]).toBe(0x00);
  });

  // generateSitemaps() support — paginated sitemaps at /products/sitemap/{id}.xml
  it("serves /products/sitemap/0.xml from generateSitemaps", async () => {
    const res = await fetch(`${baseUrl}/products/sitemap/0.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<urlset");
    expect(xml).toContain("https://example.com/products/batch-0/item-1");
    expect(xml).toContain("https://example.com/products/batch-0/item-2");
    // Should NOT contain entries from other batches
    expect(xml).not.toContain("batch-1");
  });

  it("serves /products/sitemap/1.xml with distinct entries", async () => {
    const res = await fetch(`${baseUrl}/products/sitemap/1.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("https://example.com/products/batch-1/item-1");
    expect(xml).toContain("https://example.com/products/batch-1/item-2");
    expect(xml).not.toContain("batch-0");
  });

  // Ported from Next.js: test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
  // "Should 404 when missing .xml extension"
  it("returns 404 for sitemap id without .xml extension", async () => {
    const res = await fetch(`${baseUrl}/products/sitemap/0`);
    expect(res.status).toBe(404);
  });

  it("serves /products/sitemap/featured.xml with string id", async () => {
    const res = await fetch(`${baseUrl}/products/sitemap/featured.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("https://example.com/products/batch-featured/item-1");
    expect(xml).toContain("https://example.com/products/batch-featured/item-2");
  });

  it("returns 404 for invalid sitemap id", async () => {
    const res = await fetch(`${baseUrl}/products/sitemap/99.xml`);
    expect(res.status).toBe(404);
  });

  it("does not serve /products/sitemap.xml when generateSitemaps exists", async () => {
    const res = await fetch(`${baseUrl}/products/sitemap.xml`);
    // The base URL should not match — either 404 or falls through to page routing
    expect(res.status).toBe(404);
  });

  it("scanMetadataFiles discovers nested products/sitemap.ts", async () => {
    const { scanMetadataFiles } = await import("../packages/vinext/src/server/metadata-routes.js");
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);
    const productsSitemap = routes.find(
      (r: { type: string; servedUrl: string }) =>
        r.type === "sitemap" && r.servedUrl === "/products/sitemap.xml",
    );
    expect(productsSitemap).toBeDefined();
    expect(productsSitemap!.isDynamic).toBe(true);
  });

  it("scanMetadataFiles discovers opengraph-image in dynamic segment", async () => {
    const { scanMetadataFiles } = await import("../packages/vinext/src/server/metadata-routes.js");
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);
    const ogImage = routes.find(
      (r: { type: string; servedUrl: string }) =>
        r.type === "opengraph-image" && r.servedUrl === "/blog/[slug]/opengraph-image",
    );
    expect(ogImage).toBeDefined();
    expect(ogImage!.isDynamic).toBe(true);
  });

  it("scanMetadataFiles discovers static metadata files in dynamic segments with placeholders", async () => {
    const { scanMetadataFiles } = await import("../packages/vinext/src/server/metadata-routes.js");
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);
    const icon = routes.find(
      (r: { type: string; servedUrl: string }) =>
        r.type === "icon" && r.servedUrl === "/metadata-dynamic-static/-/icon.png",
    );
    expect(icon).toBeDefined();
    expect(icon!.isDynamic).toBe(false);
  });

  it("serves static metadata files in dynamic segments from placeholder urls", async () => {
    const res = await fetch(`${baseUrl}/metadata-dynamic-static/-/icon.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("injects file-based metadata into not-found fallback pages", async () => {
    const res = await fetch(`${baseUrl}/missing-metadata-page`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+href="[^"]*\/favicon\.ico(?:\?[^"]+)?"[^>]*>/);
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+href="[^"]*\/icon(?:\?[^"]+)?"[^>]*>/);
    expect(html).toMatch(/<link[^>]+rel="manifest"[^>]+href="[^"]*\/manifest\.webmanifest"[^>]*>/);
  });

  it("serves dynamic opengraph-image in dynamic segment with params", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world/opengraph-image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const text = await res.text();
    expect(text).toBe("og:hello-world");
  });

  it("serves dynamic opengraph-image with different param values", async () => {
    const res = await fetch(`${baseUrl}/blog/my-post/opengraph-image`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("og:my-post");
  });

  it("serves dynamic icon routes generated by generateImageMetadata", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    const res = await fetch(`${baseUrl}/metadata-multi-image/big/icon/big-small`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("returns 404 for unknown generateImageMetadata ids", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    const res = await fetch(`${baseUrl}/metadata-multi-image/big/icon/missing`);
    expect(res.status).toBe(404);
  });

  it("serves generateImageMetadata ids after catch-all metadata route params", async () => {
    const res = await fetch(`${baseUrl}/metadata-multi-catchall/a/b/icon/a-b-small`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("serves valid generateImageMetadata ids when invalid siblings are present", async () => {
    const res = await fetch(`${baseUrl}/metadata-invalid-id-sibling/icon/good`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });
});
