import { describe, expect, it } from "vite-plus/test";
import { minifyStyledJsxCss } from "../packages/vinext/src/plugins/styled-jsx.js";
import { normalizePagesInlineStyleTags } from "../packages/vinext/src/server/pages-page-response.js";

describe("styled-jsx transform", () => {
  it("minifies static style jsx template literals for Pages SSR parity", () => {
    // Ported from Next.js: test/e2e/streaming-ssr/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/index.test.ts
    const transformed = normalizePagesInlineStyleTags(`
      <html><head><style>body { margin: 0 }</style></head>
      <body>
          <style>
            p {
              color: blue;
            }
          </style>
      </body></html>
    `);

    expect(transformed).toContain("body { margin: 0 }");
    expect(transformed).toContain("p{color:blue;}");
  });

  it("normalizes safe CSS whitespace without rewriting values", () => {
    expect(minifyStyledJsxCss("p, a { font-family: Test Sans; color: #00f; }")).toBe(
      "p,a{font-family:Test Sans;color:#00f;}",
    );
  });
});
