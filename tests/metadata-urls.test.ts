import { describe, expect, it } from "vite-plus/test";
import { renderMetadataToHtml } from "../packages/vinext/src/shims/metadata.js";

// Ported from Next.js: test/e2e/app-dir/metadata/metadata.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata/metadata.test.ts
describe("metadata alternate URLs", () => {
  it("resolves descriptor arrays against a string metadataBase", () => {
    const html = renderMetadataToHtml(
      {
        metadataBase: "https://example.com",
        alternates: {
          canonical: { url: "./" },
          languages: { "en-US": "./en-US", omitted: null },
          media: { print: [{ url: "/print", title: "Print" }] },
          types: {
            "application/rss+xml": [
              { url: "/blog.rss", title: "rss" },
              { url: "/blog/js.rss", title: "js title" },
            ],
          },
        },
      },
      "/alternates",
    );
    expect(html).toContain('rel="canonical" href="https://example.com/alternates"');
    expect(html).toContain('href="https://example.com/alternates/en-US" hreflang="en-US"');
    expect(html).toContain('href="https://example.com/print" title="Print" media="print"');
    expect(html).toContain(
      'href="https://example.com/blog.rss" title="rss" type="application/rss+xml"',
    );
    expect(html).toContain(
      'href="https://example.com/blog/js.rss" title="js title" type="application/rss+xml"',
    );
    expect(html).not.toContain("omitted");
  });

  it("resolves URL-instance canonical descriptors with the current pathname", () => {
    const html = renderMetadataToHtml(
      {
        metadataBase: "https://example.com",
        alternates: { canonical: { url: new URL("https://other.example/root?ref=source") } },
      },
      "/article",
    );
    expect(html).toContain('rel="canonical" href="https://other.example/article?ref=source"');
  });
});
