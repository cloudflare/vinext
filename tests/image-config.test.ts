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
  matchLocalPattern,
  hasLocalMatch,
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

// ─── matchLocalPattern ──────────────────────────────────────────────────

describe("matchLocalPattern", () => {
  it("matches when no pathname specified (defaults to **)", () => {
    expect(matchLocalPattern({}, new URL("/any/path.jpg", "http://n"))).toBe(true);
  });

  it("matches exact pathname", () => {
    expect(
      matchLocalPattern({ pathname: "/images/hero.png" }, new URL("/images/hero.png", "http://n")),
    ).toBe(true);
  });

  it("rejects non-matching pathname", () => {
    expect(
      matchLocalPattern({ pathname: "/images/hero.png" }, new URL("/other/photo.png", "http://n")),
    ).toBe(false);
  });

  it("matches single-segment wildcard", () => {
    expect(
      matchLocalPattern({ pathname: "/images/*" }, new URL("/images/photo.png", "http://n")),
    ).toBe(true);
    expect(
      matchLocalPattern({ pathname: "/images/*" }, new URL("/images/deep/photo.png", "http://n")),
    ).toBe(false);
  });

  it("matches multi-segment wildcard", () => {
    expect(
      matchLocalPattern({ pathname: "/images/**" }, new URL("/images/a/b/c.png", "http://n")),
    ).toBe(true);
  });

  it("matches search parameter", () => {
    expect(matchLocalPattern({ search: "?v=1" }, new URL("/img.png?v=1", "http://n"))).toBe(true);
    expect(matchLocalPattern({ search: "?v=1" }, new URL("/img.png?v=2", "http://n"))).toBe(false);
  });

  it("skips search check when not specified", () => {
    expect(matchLocalPattern({}, new URL("/img.png?anything=here", "http://n"))).toBe(true);
  });

  it("combines pathname and search", () => {
    expect(
      matchLocalPattern(
        { pathname: "/uploads/**", search: "?token=abc" },
        new URL("/uploads/file.jpg?token=abc", "http://n"),
      ),
    ).toBe(true);
    expect(
      matchLocalPattern(
        { pathname: "/uploads/**", search: "?token=abc" },
        new URL("/uploads/file.jpg?token=xyz", "http://n"),
      ),
    ).toBe(false);
  });
});

// ─── hasLocalMatch ──────────────────────────────────────────────────────

describe("hasLocalMatch", () => {
  it("returns true when localPatterns is undefined (allow all)", () => {
    expect(hasLocalMatch(undefined, "/anything/here.jpg")).toBe(true);
  });

  it("matches when path fits a pattern", () => {
    expect(hasLocalMatch([{ pathname: "/allowed/**" }], "/allowed/img.jpg")).toBe(true);
  });

  it("rejects when path doesn't fit any pattern", () => {
    expect(hasLocalMatch([{ pathname: "/allowed/**" }], "/blocked/img.jpg")).toBe(false);
  });

  it("matches any of multiple patterns", () => {
    expect(hasLocalMatch([{ pathname: "/a/**" }, { pathname: "/b/**" }], "/b/img.jpg")).toBe(true);
  });

  it("empty array rejects everything", () => {
    expect(hasLocalMatch([], "/anything.jpg")).toBe(false);
  });
});

// ─── Additional remote pattern edge cases (ported from Next.js) ─────────

describe("matchRemotePattern hostname glob edge cases", () => {
  it("* does not match empty string in hostname", () => {
    // *.example.com should not match example.com (wildcard requires at least one segment)
    const pattern: RemotePattern = { hostname: "*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.png"))).toBe(false);
  });

  it("* matches single segment at beginning of hostname", () => {
    const pattern: RemotePattern = { hostname: "*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.png"))).toBe(true);
  });

  it("* in middle of hostname matches single label", () => {
    const pattern: RemotePattern = { hostname: "cdn.*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.us.example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://cdn.eu.example.com/img.png"))).toBe(true);
  });

  it("* in middle of hostname does not match multiple labels", () => {
    const pattern: RemotePattern = { hostname: "cdn.*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.us.east.example.com/img.png"))).toBe(
      false,
    );
  });

  it("* at end of hostname matches single label", () => {
    const pattern: RemotePattern = { hostname: "cdn.example.*" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.org/img.png"))).toBe(true);
  });

  it("** matches multiple labels in hostname", () => {
    const pattern: RemotePattern = { hostname: "**.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://a.b.c.example.com/img.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.png"))).toBe(true);
  });
});

describe("matchRemotePattern pathname glob edge cases", () => {
  it("* at beginning of segment matches filename", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/images/*.png" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/photo.png"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/photo.jpg"))).toBe(
      false,
    );
  });

  it("* in middle of pathname segment", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/img-*-thumb" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/img-12345-thumb"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/img-abc-thumb"))).toBe(true);
  });

  it("* at end of segment matches extension", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/uploads/photo.*" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/uploads/photo.jpg"))).toBe(
      true,
    );
    expect(matchRemotePattern(pattern, new URL("https://example.com/uploads/photo.png"))).toBe(
      true,
    );
  });

  it("* does not match path separator", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/images/*" };
    // * should match a single segment, not cross /
    expect(matchRemotePattern(pattern, new URL("https://example.com/images/a/b.png"))).toBe(false);
  });

  it("** matches hidden files (dotfiles)", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/uploads/**" };
    expect(matchRemotePattern(pattern, new URL("https://example.com/uploads/.hidden"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://example.com/uploads/.a/b.png"))).toBe(true);
  });

  it("** matches deeply nested paths", () => {
    const pattern: RemotePattern = { hostname: "example.com", pathname: "/assets/**" };
    expect(
      matchRemotePattern(pattern, new URL("https://example.com/assets/images/2024/01/photo.jpg")),
    ).toBe(true);
  });

  it("combines hostname and pathname globs together", () => {
    const pattern: RemotePattern = {
      hostname: "*.cdn.example.com",
      pathname: "/v1/*/images/**",
    };
    expect(
      matchRemotePattern(
        pattern,
        new URL("https://us.cdn.example.com/v1/bucket123/images/photo.jpg"),
      ),
    ).toBe(true);
    expect(
      matchRemotePattern(
        pattern,
        new URL("https://eu.cdn.example.com/v1/bucket456/images/a/b/c.png"),
      ),
    ).toBe(true);
    // Wrong hostname (no subdomain)
    expect(
      matchRemotePattern(pattern, new URL("https://cdn.example.com/v1/bucket/images/photo.jpg")),
    ).toBe(false);
    // Wrong pathname (missing /images/ segment)
    expect(
      matchRemotePattern(pattern, new URL("https://us.cdn.example.com/v1/bucket/other/photo.jpg")),
    ).toBe(false);
  });
});

describe("matchRemotePattern with URL object as pattern", () => {
  it("accepts URL object as pattern", () => {
    const pattern = new URL("https://cdn.example.com/images/photo.png");
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/images/photo.png"))).toBe(
      true,
    );
  });

  it("URL pattern matches protocol exactly", () => {
    const pattern = new URL("https://cdn.example.com/img.png");
    expect(matchRemotePattern(pattern, new URL("http://cdn.example.com/img.png"))).toBe(false);
  });

  it("URL pattern matches pathname exactly", () => {
    const pattern = new URL("https://cdn.example.com/images/photo.png");
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/images/other.png"))).toBe(
      false,
    );
  });
});

describe("matchLocalPattern additional edge cases", () => {
  it("* matches hidden files at root", () => {
    // * matches a single segment including dotfiles
    expect(matchLocalPattern({ pathname: "/*" }, new URL("/.hidden", "http://n"))).toBe(true);
  });

  it("** matches nested hidden paths", () => {
    expect(matchLocalPattern({ pathname: "/**" }, new URL("/.config/file.jpg", "http://n"))).toBe(
      true,
    );
  });

  it("exact pathname does not match with trailing slash", () => {
    expect(
      matchLocalPattern(
        { pathname: "/images/photo.png" },
        new URL("/images/photo.png/", "http://n"),
      ),
    ).toBe(false);
  });

  it("empty pathname pattern matches nothing", () => {
    // Empty string is not ** — it should match empty pathname only
    expect(matchLocalPattern({ pathname: "" }, new URL("/img.jpg", "http://n"))).toBe(false);
    expect(matchLocalPattern({ pathname: "" }, new URL("/", "http://n"))).toBe(false);
  });
});
