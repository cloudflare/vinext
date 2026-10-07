import mdx from "@mdx-js/rollup";
import { describe, expect, it } from "vitest";
import { rehypeHeadingLinks } from "../apps/web/rehype-heading-links";

describe("docs heading links", () => {
  it("compiles formatted headings into accessible links with unique, stable targets", async () => {
    const source = [
      "## Cache **warming**",
      "### Cache warming",
      "## Cache warming-1",
      "## Which option should I choose?",
      "## Café and `缓存`",
    ].join("\n\n");
    const plugin = mdx({ rehypePlugins: [rehypeHeadingLinks] });
    const result = await plugin.transform(source, "/docs/headings.mdx");

    for (const id of [
      "cache-warming",
      "cache-warming-1",
      "cache-warming-1-1",
      "which-option-should-i-choose",
      "café-and-缓存",
    ]) {
      expect(result?.code).toContain(`id: "${id}"`);
      expect(result?.code).toContain(`href: "#${id}"`);
    }
    expect(result?.code).toContain('"aria-label": "Link to Cache warming"');
    expect(result?.code).toContain('"aria-hidden": "true"');
    expect(result?.code).toContain('className: "docs-heading-link"');
    expect((await plugin.transform(source, "/docs/another-page.mdx"))?.code).toBe(result?.code);
  });
});
