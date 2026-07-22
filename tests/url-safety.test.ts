import { describe, it, expect } from "vite-plus/test";
import { isDangerousScheme } from "../packages/vinext/src/shims/url-safety.js";

describe("isDangerousScheme", () => {
  describe("basic dangerous schemes", () => {
    it("detects javascript: scheme", () => {
      expect(isDangerousScheme("javascript:alert(1)")).toBe(true);
    });

    it("detects data: scheme", () => {
      expect(isDangerousScheme("data:text/html,<h1>XSS</h1>")).toBe(true);
    });

    it("detects vbscript: scheme", () => {
      expect(isDangerousScheme("vbscript:MsgBox")).toBe(true);
    });

    it("detects bare scheme with colon only", () => {
      expect(isDangerousScheme("javascript:")).toBe(true);
      expect(isDangerousScheme("data:")).toBe(true);
      expect(isDangerousScheme("vbscript:")).toBe(true);
    });
  });

  describe("case insensitivity", () => {
    it("detects uppercase schemes", () => {
      expect(isDangerousScheme("JAVASCRIPT:alert(1)")).toBe(true);
      expect(isDangerousScheme("DATA:text/html,foo")).toBe(true);
      expect(isDangerousScheme("VBSCRIPT:MsgBox")).toBe(true);
    });

    it("detects mixed-case schemes", () => {
      expect(isDangerousScheme("JavaScript:alert(1)")).toBe(true);
      expect(isDangerousScheme("jAvAsCrIpT:void(0)")).toBe(true);
      expect(isDangerousScheme("DaTa:text/html,foo")).toBe(true);
      expect(isDangerousScheme("VbScript:MsgBox")).toBe(true);
    });
  });

  describe("leading whitespace bypass attempts", () => {
    it("detects schemes with leading spaces", () => {
      expect(isDangerousScheme(" javascript:alert(1)")).toBe(true);
      expect(isDangerousScheme("   javascript:alert(1)")).toBe(true);
    });

    it("detects schemes with leading tabs", () => {
      expect(isDangerousScheme("\tjavascript:alert(1)")).toBe(true);
      expect(isDangerousScheme("\t\tdata:text/html,foo")).toBe(true);
    });

    it("detects schemes with leading newlines", () => {
      expect(isDangerousScheme("\njavascript:alert(1)")).toBe(true);
      expect(isDangerousScheme("\r\njavascript:alert(1)")).toBe(true);
    });

    it("detects schemes with leading form feeds", () => {
      expect(isDangerousScheme("\fjavascript:alert(1)")).toBe(true);
    });

    it("detects schemes with mixed leading whitespace", () => {
      expect(isDangerousScheme(" \t\n\r javascript:alert(1)")).toBe(true);
    });
  });

  describe("zero-width character bypass attempts", () => {
    it("detects schemes with leading zero-width space (U+200B)", () => {
      expect(isDangerousScheme("\u200Bjavascript:alert(1)")).toBe(true);
    });

    it("detects schemes with leading BOM / zero-width no-break space (U+FEFF)", () => {
      expect(isDangerousScheme("\uFEFFjavascript:alert(1)")).toBe(true);
    });

    it("detects schemes with multiple leading zero-width chars", () => {
      expect(isDangerousScheme("\u200B\uFEFF\u200Bjavascript:alert(1)")).toBe(true);
    });
  });

  describe("mixed whitespace and zero-width chars", () => {
    it("detects schemes with mixed leading whitespace and zero-width chars", () => {
      expect(isDangerousScheme(" \u200B\tjavascript:alert(1)")).toBe(true);
      expect(isDangerousScheme("\uFEFF \n\u200Bdata:text/html,foo")).toBe(true);
    });
  });

  describe("whitespace between scheme name and colon", () => {
    it("does not flag spaces before the colon", () => {
      // Browsers do not normalize plain spaces before the colon into a valid
      // scheme separator, so these are not treated as javascript: URLs.
      expect(isDangerousScheme("javascript :alert(1)")).toBe(false);
      expect(isDangerousScheme("javascript   :alert(1)")).toBe(false);
    });

    it("detects schemes with tab before the colon", () => {
      expect(isDangerousScheme("javascript\t:alert(1)")).toBe(true);
    });

    it("does not flag zero-width space (U+200B) between scheme and colon", () => {
      // The regex uses \s* between the scheme name and colon.
      // U+200B is not matched by \s, so it breaks the pattern.
      expect(isDangerousScheme("javascript\u200B:alert(1)")).toBe(false);
    });

    it("does not flag BOM (U+FEFF) between scheme and colon", () => {
      expect(isDangerousScheme("javascript\uFEFF:alert(1)")).toBe(false);
    });
  });

  describe("embedded control-character bypass attempts", () => {
    it("detects javascript: with embedded newline characters", () => {
      expect(isDangerousScheme("java\nscript:alert(1)")).toBe(true);
      expect(isDangerousScheme("ja\nvascript:alert(1)")).toBe(true);
      expect(isDangerousScheme("JAVA\nSCRIPT:alert(1)")).toBe(true);
    });

    it("detects javascript: with embedded carriage returns and tabs", () => {
      expect(isDangerousScheme("java\rscript:alert(1)")).toBe(true);
      expect(isDangerousScheme("java\tscript:alert(1)")).toBe(true);
      expect(isDangerousScheme("java\r\nscript:alert(1)")).toBe(true);
    });

    it("detects dangerous schemes with leading NUL characters", () => {
      expect(isDangerousScheme("\x00javascript:alert(1)")).toBe(true);
      expect(isDangerousScheme("\x00data:text/html,<h1>XSS</h1>")).toBe(true);
      expect(isDangerousScheme("\x00vbscript:MsgBox")).toBe(true);
    });

    it("detects data: and vbscript: with embedded newlines", () => {
      expect(isDangerousScheme("da\nta:text/html,<h1>XSS</h1>")).toBe(true);
      expect(isDangerousScheme("vb\nscript:MsgBox")).toBe(true);
    });
  });

  describe("safe URLs that should not be flagged", () => {
    it("allows http: URLs", () => {
      expect(isDangerousScheme("http://example.com")).toBe(false);
    });

    it("allows https: URLs", () => {
      expect(isDangerousScheme("https://example.com")).toBe(false);
    });

    it("allows absolute paths", () => {
      expect(isDangerousScheme("/about")).toBe(false);
      expect(isDangerousScheme("/users/123")).toBe(false);
    });

    it("allows relative paths", () => {
      expect(isDangerousScheme("about")).toBe(false);
      expect(isDangerousScheme("./page")).toBe(false);
      expect(isDangerousScheme("../parent")).toBe(false);
    });

    it("allows hash-only URLs", () => {
      expect(isDangerousScheme("#section")).toBe(false);
      expect(isDangerousScheme("#")).toBe(false);
    });

    it("allows mailto: URLs", () => {
      expect(isDangerousScheme("mailto:user@example.com")).toBe(false);
    });

    it("allows tel: URLs", () => {
      expect(isDangerousScheme("tel:+1234567890")).toBe(false);
    });

    it("allows ftp: URLs", () => {
      expect(isDangerousScheme("ftp://files.example.com")).toBe(false);
    });

    it("allows empty string", () => {
      expect(isDangerousScheme("")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("does not flag scheme-like strings in the path portion", () => {
      expect(isDangerousScheme("https://example.com/javascript:foo")).toBe(false);
      expect(isDangerousScheme("/data:something")).toBe(false);
      expect(isDangerousScheme("http://host/vbscript:bar")).toBe(false);
    });

    it("does not flag dangerous scheme in query string parameters", () => {
      expect(isDangerousScheme("https://example.com?redirect=javascript:alert(1)")).toBe(false);
      expect(isDangerousScheme("/login?next=data:text/html,foo")).toBe(false);
    });

    it("does not flag scheme name without colon", () => {
      expect(isDangerousScheme("javascript")).toBe(false);
      expect(isDangerousScheme("data")).toBe(false);
      expect(isDangerousScheme("vbscript")).toBe(false);
    });

    it("does not flag scheme name as substring of another word", () => {
      expect(isDangerousScheme("myjavascript:foo")).toBe(false);
      expect(isDangerousScheme("metadata:bar")).toBe(false);
    });

    it("detects scheme with payload after colon", () => {
      expect(isDangerousScheme("javascript:void(0)")).toBe(true);
      expect(isDangerousScheme("data:image/png;base64,abc")).toBe(true);
    });

    it("detects scheme with combined bypass techniques", () => {
      // Leading control/zero-width chars and embedded tab/newline remain blocked.
      expect(isDangerousScheme("\u200B\uFEFF\x00JaVa\nScRiPt\t:alert(1)")).toBe(true);
    });
  });
});
