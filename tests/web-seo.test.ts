import { describe, expect, it } from "vitest";
import { createBenchmarkMetadata } from "../apps/web/app/benchmarks/metadata";
import robots from "../apps/web/app/robots";
import sitemap from "../apps/web/app/sitemap";
import { addPreviewRobotsHeader, getCanonicalRedirect } from "../apps/web/worker/seo";

describe("vinext.dev SEO metadata", () => {
  it("builds canonical and social metadata for benchmark detail pages", () => {
    const metadata = createBenchmarkMetadata({
      title: "Commit abc1234 performance benchmarks",
      description: "Historical vinext performance measurements by commit.",
      path: "/benchmarks/commit/abc1234",
    });

    const canonical = metadata.alternates?.canonical;
    expect(canonical).toBe("/benchmarks/commit/abc1234");
    expect(metadata.openGraph).toMatchObject({
      title: "Commit abc1234 performance benchmarks — vinext",
      url: "/benchmarks/commit/abc1234",
      siteName: "vinext",
    });
    expect(metadata.robots).toBeUndefined();
  });

  it("publishes a crawlable robots policy pointing at the canonical sitemap", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
      },
      sitemap: "https://vinext.dev/sitemap.xml",
    });
  });

  it("lists only stable, indexable pages in the sitemap", () => {
    expect(sitemap().map(({ url }) => url)).toEqual([
      "https://vinext.dev",
      "https://vinext.dev/compatibility",
      "https://vinext.dev/benchmarks",
    ]);
  });
});

describe("vinext.dev canonical host handling", () => {
  it.each(["www.vinext.dev", "vinext-web.vinext.workers.dev"])(
    "redirects public documents from %s while preserving path and query",
    (hostname) => {
      const response = getCanonicalRedirect(
        new Request(`https://${hostname}/benchmarks?view=bundles`),
      );

      expect(response?.status).toBe(308);
      expect(response?.headers.get("location")).toBe("https://vinext.dev/benchmarks?view=bundles");
    },
  );

  it("redirects HTTP documents on the canonical host to HTTPS", () => {
    const response = getCanonicalRedirect(new Request("http://vinext.dev/benchmarks?view=bundles"));

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe("https://vinext.dev/benchmarks?view=bundles");
  });

  it("keeps the workers.dev API origin available to existing CI uploaders", () => {
    expect(
      getCanonicalRedirect(
        new Request("https://vinext-web.vinext.workers.dev/api/benchmarks/upload"),
      ),
    ).toBeNull();
    expect(
      getCanonicalRedirect(
        new Request("https://vinext-web.vinext.workers.dev/benchmarks", { method: "POST" }),
      ),
    ).toBeNull();
    expect(
      getCanonicalRedirect(
        new Request("https://vinext-web.vinext.workers.dev/__vinext/prerender/readiness", {
          method: "POST",
        }),
      ),
    ).toBeNull();
  });

  it("marks preview aliases as non-indexable without buffering the response body", async () => {
    const response = addPreviewRobotsHeader(
      new Request("https://pr-123-vinext-web.vinext.workers.dev/"),
      new Response("preview", { headers: { "content-type": "text/plain" } }),
    );

    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("preview");
  });

  it("does not add preview directives to canonical production hosts", () => {
    for (const hostname of ["vinext.dev", "vinext-web.vinext.workers.dev"]) {
      const original = new Response("production");
      expect(addPreviewRobotsHeader(new Request(`https://${hostname}/`), original)).toBe(original);
    }
  });
});
