import { describe, expect, it } from "vite-plus/test";
import {
  createCssDataUrlPlugin,
  decodeCssDataUrl,
} from "../packages/vinext/src/plugins/css-data-url.js";

describe("css data URL imports", () => {
  it("decodes plain CSS data URLs with hash selectors", () => {
    // Ported from Next.js: test/e2e/css-data-url-global-pages/css-data-url-global-pages.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/css-data-url-global-pages/css-data-url-global-pages.test.ts
    expect(decodeCssDataUrl("data:text/css,#styled{font-weight:700}")).toBe(
      "#styled{font-weight:700}",
    );
  });

  it("resolves CSS data URLs to browser style injection modules", async () => {
    const plugin = createCssDataUrlPlugin();
    const resolved = await (plugin.resolveId as (id: string) => string | null)(
      "data:text/css,#styled{font-weight:700}",
    );

    expect(resolved).toContain("vinext:css-data-url");

    const code = await (plugin.load as (id: string) => string | null)(resolved!);

    expect(code).toContain("#styled{font-weight:700}");
    expect(code).toContain('document.createElement("style")');
    expect(code).toContain("document.head.appendChild(style)");
  });
});
