/**
 * Image remote pattern matching unit tests.
 *
 * Tests the glob-based URL validation that prevents SSRF and open-redirect
 * attacks via next/image. Covers hostname globs, pathname globs, protocol,
 * port, and search matching — mirroring Next.js's matchRemotePattern semantics.
 */
import { describe, it, expect } from "vitest";
import {
  matchRemotePattern,
  hasRemoteMatch,
  type RemotePattern,
} from "../packages/vinext/src/shims/image-config.js";

// ─── matchRemotePattern: hostname matching ──────────────────────────────

describe("matchRemotePattern hostname", () => {
  it("matches exact hostname", () => {
    const pattern: RemotePattern = { hostname: "example.com" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(true);
  });

  it("rejects different hostname", () => {
    const pattern: RemotePattern = { hostname: "example.com" };
    expect(matchRemotePattern(pattern, new URL("https://other.com/img.png"))).toBe(false);
  });

  it("matches single-segment wildcard (*)", () => {
    const pattern: RemotePattern = { hostname: "*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://images.example.com/img.png"))).toBe(true);
  });

  it("single wildcard does not match deep subdomains", () => {
    const pattern: RemotePattern = { hostname: "*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://deep.cdn.example.com/img.png"))).toBe(
      false,
    );
  });

  it("matches double-star wildcard (**) for deep subdomains", () => {
    const pattern: RemotePattern = { hostname: "**.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://deep.cdn.example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://a.b.c.example.com/img.png"))).toBe(true);
  });

  it("wildcard hostname does not match bare domain", () => {
    const pattern: RemotePattern = { hostname: "*.example.com" };
    // *.example.com should NOT match "example.com" itself (no subdomain)
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(false);
  });
});

// ─── matchRemotePattern: protocol matching ──────────────────────────────

describe("matchRemotePattern protocol", () => {
  it("matches when protocol matches (without colon)", () => {
    const pattern: RemotePattern = { hostname: "example.com", protocol: "https" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(true);
  });

  it("matches when protocol matches (with colon)", () => {
    const pattern: RemotePattern = { hostname: "example.com", protocol: "https:" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(true);
  });

  it("rejects when protocol doesn't match", () => {
    const pattern: RemotePattern = { hostname: "example.com", protocol: "https" };
    expect(matchRemotePattern(pattern, new URL("http://example.com/img.png"))).toBe(false);
  });

  it("skips protocol check when not specified", () => {
    const pattern: RemotePattern = { hostname: "example.com" };
    expect(matchRemotePattern(pattern, new URL("http://example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(true);
  });
});

// ─── matchRemotePattern: port matching ──────────────────────────────────

describe("matchRemotePattern port", () => {
  it("matches specific port", () => {
    const pattern: RemotePattern = { hostname: "example.com", port: "8080" };
    expect(matchRemotePattern(pattern, new URL("https://example.com:8080/img.png"))).toBe(true);
  });

  it("rejects wrong port", () => {
    const pattern: RemotePattern = { hostname: "example.com", port: "8080" };
    expect(matchRemotePattern(pattern, new URL("https://example.com:3000/img.png"))).toBe(false);
  });

  it("rejects when port required but not in URL", () => {
    const pattern: RemotePattern = { hostname: "example.com", port: "8080" };
    // URL.port is "" for default ports
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(false);
  });

  it("matches empty port string for default port URLs", () => {
    const pattern: RemotePattern = { hostname: "example.com", port: "" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(true);
  });

  it("skips port check when not specified", () => {
    const pattern: RemotePattern = { hostname: "example.com" };
    expect(matchRemotePattern(pattern, new URL("https://example.com:9999/img.png"))).toBe(true);
  });
});

// ─── matchRemotePattern: pathname matching ──────────────────────────────

describe("matchRemotePattern pathname", () => {
  it("defaults to ** (match everything) when not specified", () => {
    const pattern: RemotePattern = { hostname: "example.com" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/any/path/here.png"))).toBe(
      true,
    );
  });

  it("matches exact pathname", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/images/hero.png" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/hero.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/other.png"))).toBe(
      false,
    );
  });

  it("matches single-segment pathname wildcard", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/images/*" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/photo.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/deep/photo.png"))).toBe(
      false,
    );
  });

  it("matches multi-segment pathname wildcard", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/images/**" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/photo.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/a/b/c.png"))).toBe(true);
  });

  it("rejects non-matching pathname", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/uploads/*" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/photo.png"))).toBe(
      false,
    );
  });
});

// ─── matchRemotePattern: search matching ────────────────────────────────

describe("matchRemotePattern search", () => {
  it("matches exact search string", () => {
    const pattern: RemotePattern = { hostname: "example.com", search: "?v=1" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png?v=1"))).toBe(true);
  });

  it("rejects wrong search string", () => {
    const pattern: RemotePattern = { hostname: "example.com", search: "?v=1" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png?v=2"))).toBe(false);
  });

  it("skips search check when not specified", () => {
    const pattern: RemotePattern = { hostname: "example.com" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png?anything=here"))).toBe(
      true,
    );
  });
});

// ─── hasRemoteMatch ─────────────────────────────────────────────────────

describe("hasRemoteMatch", () => {
  it("matches by domain name", () => {
    expect(
      hasRemoteMatch(["cdn.example.com"], [], new URL("https://cdn.example.com/photo.png")),
    ).toBe(true);
  });

  it("does not match unrecognized domain", () => {
    expect(hasRemoteMatch(["cdn.example.com"], [], new URL("https://evil.com/photo.png"))).toBe(
      false,
    );
  });

  it("matches by remote pattern", () => {
    expect(
      hasRemoteMatch(
        [],
        [{ hostname: "*.example.com", pathname: "/images/**" }],
        new URL("https://cdn.example.com/images/photo.png"),
      ),
    ).toBe(true);
  });

  it("matches when either domain or pattern matches", () => {
    expect(
      hasRemoteMatch(
        ["other.com"],
        [{ hostname: "cdn.example.com" }],
        new URL("https://cdn.example.com/photo.png"),
      ),
    ).toBe(true);
  });

  it("rejects when neither domain nor pattern matches", () => {
    expect(
      hasRemoteMatch(
        ["allowed.com"],
        [{ hostname: "cdn.allowed.com" }],
        new URL("https://evil.com/photo.png"),
      ),
    ).toBe(false);
  });

  it("handles empty domains and patterns", () => {
    expect(hasRemoteMatch([], [], new URL("https://example.com/photo.png"))).toBe(false);
  });
});

// ─── Glob edge cases ────────────────────────────────────────────────────

describe("matchRemotePattern glob edge cases", () => {
  it("escapes regex special characters in hostname", () => {
    const pattern: RemotePattern = { hostname: "my.cdn.example.com" };
    // The dots in the hostname should be literal, not regex wildcards
    expect(matchRemotePattern(pattern, new URL("https://my.cdn.example.com/img.png"))).toBe(true);
    // "myXcdnXexample.com" should NOT match (dot is literal, not regex any-char)
    expect(matchRemotePattern(pattern, new URL("https://myXcdnXexampleXcom/img.png"))).toBe(false);
  });

  it("escapes regex special characters in pathname", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/images/photo.png" };
    // The dot before 'png' should be literal
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/photo.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/photoXpng"))).toBe(
      false,
    );
  });

  it("handles multiple wildcards in pattern", () => {
    const pattern: RemotePattern = { hostname: "*.*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://a.b.example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://a.example.com/img.png"))).toBe(false);
  });

  it("combines hostname and pathname globs", () => {
    const pattern: RemotePattern = {
      hostname: "*.example.com",
      pathname: "/uploads/**",
      protocol: "https",
    };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/uploads/a/b.png"))).toBe(
      true,
    );
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/other/a.png"))).toBe(false);
    expect(matchRemotePattern(pattern, new URL("http://cdn.example.com/uploads/a.png"))).toBe(
      false,
    );
  });
});
