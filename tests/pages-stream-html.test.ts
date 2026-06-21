import { describe, expect, it } from "vite-plus/test";
import { insertHtmlAfterPagesRoot } from "../packages/vinext/src/server/pages-stream-html.js";

describe("insertHtmlAfterPagesRoot", () => {
  it("places late styles after the hydration root and before scripts", () => {
    const suffix = '</div><script src="/entry.js"></script></body></html>';
    const html = insertHtmlAfterPagesRoot(suffix, '<style id="late">p{color:blue}</style>');

    expect(html).toBe(
      '</div><style id="late">p{color:blue}</style><script src="/entry.js"></script></body></html>',
    );
  });
});
