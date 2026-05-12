/**
 * Image remote pattern matching unit tests.
 *
 * Tests the glob-based URL validation that prevents SSRF and open-redirect
 * attacks via next/image. Covers hostname globs, pathname globs, protocol,
 * port, and search matching — mirroring Next.js's matchRemotePattern semantics.
 */
import { describe, it, expect } from "vite-plus/test";
import {
  matchRemotePattern,
  hasRemoteMatch,
  isPrivateIp,
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

// ─── isPrivateIp ─────────────────────────────────────────────────────────
// Ported from Next.js: packages/next/src/server/is-private-ip.test.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/is-private-ip.test.ts

describe("isPrivateIp", () => {
  it("returns true for private IPv4 addresses", () => {
    expect(isPrivateIp("127.0.0.0")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.0.0.01")).toBe(true);
    expect(isPrivateIp("127.0.0.001")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("10.0.0.0")).toBe(true);
    expect(isPrivateIp("10.244.0.0")).toBe(true);
    expect(isPrivateIp("192.168.0.0")).toBe(true);
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("192.168.0.01")).toBe(true);
    expect(isPrivateIp("172.16.0.0")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.01")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("returns true for private IPv6 addresses", () => {
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::ffff:0.0.0.0")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateIp("2002::")).toBe(true);
    expect(isPrivateIp("ff00::")).toBe(true);
    expect(isPrivateIp("fc00::")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
  });

  it("returns true for additional non-unicast IPv4 ranges (CGNAT, multicast, reserved, benchmarking, documentation)", () => {
    expect(isPrivateIp("100.64.0.0")).toBe(true); // CGNAT (100.64.0.0/10)
    expect(isPrivateIp("100.127.255.255")).toBe(true);
    expect(isPrivateIp("198.18.0.0")).toBe(true); // benchmarking (198.18.0.0/15)
    expect(isPrivateIp("198.19.255.255")).toBe(true);
    expect(isPrivateIp("224.0.0.0")).toBe(true); // multicast (224.0.0.0/4)
    expect(isPrivateIp("239.255.255.255")).toBe(true);
    expect(isPrivateIp("240.0.0.0")).toBe(true); // reserved (240.0.0.0/4)
    expect(isPrivateIp("255.255.255.255")).toBe(true); // broadcast
    expect(isPrivateIp("192.0.0.0")).toBe(true); // IETF protocol (192.0.0.0/24)
    expect(isPrivateIp("192.0.0.255")).toBe(true);
    expect(isPrivateIp("198.51.100.0")).toBe(true); // TEST-NET-2 (198.51.100.0/24)
    expect(isPrivateIp("203.0.113.0")).toBe(true); // TEST-NET-3 (203.0.113.0/24)
  });

  it("returns true for additional non-unicast IPv6 ranges (teredo, benchmarking, documentation, discard, NAT64)", () => {
    expect(isPrivateIp("2001::1")).toBe(true); // teredo (2001::/32)
    expect(isPrivateIp("2001:0:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(isPrivateIp("2001:2::1")).toBe(true); // benchmarking (2001:2::/48, RFC 5180)
    expect(isPrivateIp("2001:db8::1")).toBe(true); // documentation (2001:db8::/32)
    expect(isPrivateIp("100::1")).toBe(true); // discard (100::/64)
    expect(isPrivateIp("64:ff9b::1")).toBe(true); // NAT64 (64:ff9b::/96)
  });

  it("returns false for public IP addresses", () => {
    expect(isPrivateIp("76.76.21.21")).toBe(false);
    expect(isPrivateIp("157.240.14.35")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIp("::ffff:1.1.1.1")).toBe(false);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });

  it("returns false for domain names", () => {
    expect(isPrivateIp("vercel.com")).toBe(false);
    expect(isPrivateIp("www.vercel.com")).toBe(false);
    expect(isPrivateIp("nextjs.org")).toBe(false);
    expect(isPrivateIp("docs.nextjs.org")).toBe(false);
  });
});
