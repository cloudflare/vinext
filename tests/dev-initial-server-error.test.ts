import { describe, expect, it } from "vite-plus/test";
import { createInitialDevServerErrorScript } from "../packages/vinext/src/server/dev-initial-server-error.js";

describe("initial dev server error script", () => {
  it("serializes server errors into an HTML-safe nonce-bearing script in development", () => {
    const error = new Error('</script><script>alert("xss")</script>');
    error.stack = "Error: boom\n    at SiteFooter (/app/site-footer.tsx:2:9)";

    const html = createInitialDevServerErrorScript(error, "vinext-nonce", "development");

    expect(html).toContain('<script nonce="vinext-nonce">');
    expect(html).toContain('self["__VINEXT_INITIAL_DEV_ERRORS__"].push');
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).not.toContain("</script><script");
    expect(html).toContain("/app/site-footer.tsx:2:9");
  });

  it("does not emit anything in production", () => {
    const html = createInitialDevServerErrorScript(new Error("secret"), undefined, "production");

    expect(html).toBe("");
  });
});
