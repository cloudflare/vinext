import { describe, it, expect } from "vitest";
import { fixFlightHints, fixPreloadAs } from "../packages/vinext/src/server/app-ssr-stream.js";

describe("App SSR stream helpers", () => {
  describe("fixPreloadAs", () => {
    it('replaces as="stylesheet" with as="style" for preload links', () => {
      expect(
        fixPreloadAs('<link rel="preload" href="/assets/index-hG1v95Xi.css" as="stylesheet"/>'),
      ).toBe('<link rel="preload" href="/assets/index-hG1v95Xi.css" as="style"/>');

      expect(fixPreloadAs('<link as="stylesheet" rel="preload" href="/file.css"/>')).toBe(
        '<link as="style" rel="preload" href="/file.css"/>',
      );
    });

    it("leaves non-preload links and other preload types unchanged", () => {
      expect(fixPreloadAs('<link rel="stylesheet" href="/file.css" as="stylesheet"/>')).toBe(
        '<link rel="stylesheet" href="/file.css" as="stylesheet"/>',
      );

      expect(fixPreloadAs('<link rel="preload" href="/font.woff2" as="font"/>')).toBe(
        '<link rel="preload" href="/font.woff2" as="font"/>',
      );

      expect(fixPreloadAs('<link rel="preload" href="/a.css" as="style"/>')).toBe(
        '<link rel="preload" href="/a.css" as="style"/>',
      );
    });

    it("handles multiple preload links in a single chunk", () => {
      const html =
        '<link rel="preload" href="/a.css" as="stylesheet"/><link rel="preload" href="/b.css" as="stylesheet"/>';
      expect(fixPreloadAs(html)).toBe(
        '<link rel="preload" href="/a.css" as="style"/><link rel="preload" href="/b.css" as="style"/>',
      );
    });
  });

  describe("fixFlightHints", () => {
    it("rewrites stylesheet hints in Flight HL records", () => {
      expect(fixFlightHints(':HL["/assets/index.css","stylesheet"]')).toBe(
        ':HL["/assets/index.css","style"]',
      );

      expect(fixFlightHints('2:HL["/assets/index.css","stylesheet",{"crossOrigin":""}]')).toBe(
        '2:HL["/assets/index.css","style",{"crossOrigin":""}]',
      );
    });

    it("leaves unrelated content unchanged", () => {
      expect(
        fixFlightHints(
          '0:D{"name":"index"}\n1:["$","link",null,{"rel":"stylesheet","href":"/file.css"}]',
        ),
      ).toBe('0:D{"name":"index"}\n1:["$","link",null,{"rel":"stylesheet","href":"/file.css"}]');

      expect(fixFlightHints('2:HL["/font.woff2","font"]')).toBe('2:HL["/font.woff2","font"]');
      expect(fixFlightHints(':HL["/font.woff2","font"]')).toBe(':HL["/font.woff2","font"]');
    });

    it("handles multiple hints in a single chunk", () => {
      expect(fixFlightHints('2:HL["/a.css","stylesheet"]\n3:HL["/b.css","stylesheet"]')).toBe(
        '2:HL["/a.css","style"]\n3:HL["/b.css","style"]',
      );
      expect(fixFlightHints(':HL["/a.css","stylesheet"]\n:HL["/b.css","stylesheet"]')).toBe(
        ':HL["/a.css","style"]\n:HL["/b.css","style"]',
      );
    });
  });
});
