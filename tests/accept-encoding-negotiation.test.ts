/**
 * Tests for RFC 9110 Accept-Encoding negotiation.
 *
 * Regression coverage for cloudflare/vinext#1981: negotiation must honor
 * numeric client preferences, exact coding tokens, wildcards, and explicit
 * refusals rather than relying on substring checks.
 */
import { describe, expect, it } from "vite-plus/test";
import type { IncomingMessage } from "node:http";
import {
  getEncodingQuality,
  HAS_ZSTD,
  isEncodingAccepted,
  negotiateEncoding,
  parseAcceptedEncodings,
  selectAcceptedEncoding,
  selectContentEncoding,
} from "../packages/vinext/src/server/accept-encoding.js";

function reqWith(acceptEncoding?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (acceptEncoding !== undefined) headers["accept-encoding"] = acceptEncoding;
  return { headers } as unknown as IncomingMessage;
}

describe("parseAcceptedEncodings", () => {
  it("retains numeric qualities for exact coding tokens", () => {
    const parsed = parseAcceptedEncodings("gzip;q=0.9, br;q=0.1");
    expect(getEncodingQuality(parsed, "gzip")).toBe(0.9);
    expect(getEncodingQuality(parsed, "br")).toBe(0.1);
  });

  it("defaults missing q parameters to one", () => {
    const parsed = parseAcceptedEncodings("gzip, br;level=4");
    expect(getEncodingQuality(parsed, "gzip")).toBe(1);
    expect(getEncodingQuality(parsed, "br")).toBe(1);
  });

  it("accepts trailing-dot q-values", () => {
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q=1."), "gzip")).toBe(1);
    expect(getEncodingQuality(parseAcceptedEncodings("br;q=0."), "br")).toBe(0);
  });

  it("accepts numeric q-values using Next.js parser semantics", () => {
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q=0.123"), "gzip")).toBe(0.123);
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q=1.000"), "gzip")).toBe(1);
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q=.5"), "gzip")).toBe(0.5);
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q=0.1234"), "gzip")).toBe(0.1234);
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q=1.5"), "gzip")).toBe(1.5);
  });

  it("drops q-values that do not start with a number", () => {
    for (const value of ["abc", ""] as const) {
      expect(getEncodingQuality(parseAcceptedEncodings(`gzip;q=${value}`), "gzip")).toBe(0);
    }
  });

  it("matches Next.js handling of bare q and spaced parameter names", () => {
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q"), "gzip")).toBe(0);
    expect(getEncodingQuality(parseAcceptedEncodings("gzip; q = 0.2"), "gzip")).toBe(1);
  });

  it("matches coding tokens exactly and case-insensitively", () => {
    const parsed = parseAcceptedEncodings("GZIP, brotli-future");
    expect(isEncodingAccepted(parsed, "gzip")).toBe(true);
    expect(isEncodingAccepted(parsed, "br")).toBe(false);
    expect(isEncodingAccepted(parsed, "brotli-future")).toBe(true);
  });

  it("matches Next.js parameter-name casing semantics", () => {
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;Q=0"), "gzip")).toBe(1);
    expect(getEncodingQuality(parseAcceptedEncodings("gzip;q=0"), "gzip")).toBe(0);
  });

  it("finds q among other parameters and uses the first repeated q parameter", () => {
    expect(getEncodingQuality(parseAcceptedEncodings("br;foo=bar;q=0"), "br")).toBe(0);
    expect(getEncodingQuality(parseAcceptedEncodings("br;q=0;foo=bar"), "br")).toBe(0);
    expect(getEncodingQuality(parseAcceptedEncodings("br;q=0;q=0.5"), "br")).toBe(0);
    expect(getEncodingQuality(parseAcceptedEncodings("br;q=0.5;q=0"), "br")).toBe(0.5);
  });

  it("uses the highest quality across duplicate coding entries", () => {
    const parsed = parseAcceptedEncodings("gzip;q=0, gzip;q=0.7, gzip;q=0.4");
    expect(getEncodingQuality(parsed, "gzip")).toBe(0.7);
  });

  it("applies wildcard quality only to codings without an explicit entry", () => {
    const parsed = parseAcceptedEncodings("*;q=0.7, br;q=0");
    expect(getEncodingQuality(parsed, "gzip")).toBe(0.7);
    expect(getEncodingQuality(parsed, "br")).toBe(0);
  });

  it("does not apply positive wildcard quality to identity", () => {
    expect(getEncodingQuality(parseAcceptedEncodings("*;q=0"), "identity")).toBe(0);
    expect(getEncodingQuality(parseAcceptedEncodings("*;q=0.4"), "identity")).toBe(1);
  });

  it("gives implicit identity quality one without a wildcard", () => {
    const parsed = parseAcceptedEncodings("gzip;q=0.8, br;q=0.2");
    expect(getEncodingQuality(parsed, "identity")).toBe(1);
  });
});

describe("selectAcceptedEncoding", () => {
  it("selects the highest client quality before server preference", () => {
    const parsed = parseAcceptedEncodings("gzip;q=1, br;q=0.1");
    expect(selectAcceptedEncoding(parsed, ["br", "gzip", "identity"])).toBe("gzip");
  });

  it("uses available order as the tie-breaker", () => {
    const parsed = parseAcceptedEncodings("gzip;q=0.5, br;q=0.5, identity;q=0.5");
    expect(selectAcceptedEncoding(parsed, ["br", "gzip", "identity"])).toBe("br");
  });

  it("returns null when every available representation is refused", () => {
    const parsed = parseAcceptedEncodings("*;q=0");
    expect(selectAcceptedEncoding(parsed, ["br", "gzip", "identity"])).toBe(null);
  });
});

describe("selectContentEncoding", () => {
  it("uses implicit identity as a fallback, matching Next.js compression", () => {
    const parsed = parseAcceptedEncodings("gzip;q=0.5");
    expect(selectContentEncoding(parsed, ["br", "gzip"])).toBe("gzip");
  });

  it("allows an explicit higher identity preference to win", () => {
    const parsed = parseAcceptedEncodings("gzip;q=0.2, identity;q=0.8");
    expect(selectContentEncoding(parsed, ["gzip"])).toBe("identity");
  });

  it("uses client header order for equal explicit qualities", () => {
    expect(
      selectContentEncoding(parseAcceptedEncodings("identity;q=0.5, gzip;q=0.5"), ["gzip"]),
    ).toBe("identity");
    expect(
      selectContentEncoding(parseAcceptedEncodings("gzip;q=0.5, identity;q=0.5"), ["gzip"]),
    ).toBe("gzip");
  });

  it("prefers explicit identity over an equal-quality wildcard", () => {
    expect(selectContentEncoding(parseAcceptedEncodings("*;q=0.5, identity;q=0.5"), ["br"])).toBe(
      "identity",
    );
  });

  it("uses the later equal-quality duplicate for identity tie ordering", () => {
    expect(
      selectContentEncoding(parseAcceptedEncodings("gzip;q=0.8, identity;q=0.8, gzip;q=0.8"), [
        "gzip",
      ]),
    ).toBe("identity");
  });

  it("lets later invalid duplicate qualities reject an earlier valid entry", () => {
    expect(selectContentEncoding(parseAcceptedEncodings("gzip, gzip;q"), ["gzip"])).toBe(
      "identity",
    );
    expect(selectContentEncoding(parseAcceptedEncodings("gzip;q=0.8, gzip;q=abc"), ["gzip"])).toBe(
      "identity",
    );
    expect(
      selectContentEncoding(parseAcceptedEncodings("identity, identity;q, gzip;q=0.5"), ["gzip"]),
    ).toBe("gzip");
  });

  it("applies duplicate-invalid replacement semantics to wildcard entries", () => {
    expect(selectContentEncoding(parseAcceptedEncodings("*, *;q"), ["br"])).toBe("identity");
    expect(selectContentEncoding(parseAcceptedEncodings("*;q, *"), ["br"])).toBe("br");
    expect(selectContentEncoding(parseAcceptedEncodings("*;q=0.8, *;q"), ["br"])).toBe("identity");
    expect(selectContentEncoding(parseAcceptedEncodings("*;q=abc, *;q=0.8"), ["br"])).toBe("br");
  });

  it("falls back to identity when no content coding is acceptable", () => {
    expect(selectContentEncoding(parseAcceptedEncodings("*;q=0"), ["br", "gzip"])).toBe("identity");
  });
});

describe("negotiateEncoding", () => {
  it("uses identity when no Accept-Encoding header is present", () => {
    expect(negotiateEncoding(reqWith(undefined))).toBe("identity");
  });

  it("honors unequal positive client preferences", () => {
    expect(negotiateEncoding(reqWith("gzip;q=1, br;q=0.1"))).toBe("gzip");
    expect(negotiateEncoding(reqWith("br;q=0.5, gzip;q=0.9"))).toBe("gzip");
  });

  it("uses server preference when client qualities tie", () => {
    expect(negotiateEncoding(reqWith("gzip;q=0.5, br;q=0.5, identity;q=0.5"))).toBe("br");
  });

  it("honors explicit refusals and exact matching", () => {
    expect(negotiateEncoding(reqWith("gzip, br;q=0"))).toBe("gzip");
    expect(negotiateEncoding(reqWith("brotli-future"))).toBe("identity");
  });

  it("honors wildcard quality and explicit overrides", () => {
    expect(negotiateEncoding(reqWith("*"))).toBe(HAS_ZSTD ? "zstd" : "br");
    expect(negotiateEncoding(reqWith("*;q=0.8, br;q=0"))).toBe(HAS_ZSTD ? "zstd" : "gzip");
    expect(negotiateEncoding(reqWith("*;q=0, gzip"))).toBe("gzip");
  });

  it("returns identity when it is the preferred representation", () => {
    expect(negotiateEncoding(reqWith("gzip;q=0.2, identity;q=0.8"))).toBe("identity");
  });

  it("falls back to identity when every supported coding is refused", () => {
    expect(negotiateEncoding(reqWith("*;q=0"))).toBe("identity");
    expect(negotiateEncoding(reqWith("gzip;q=0, br;q=0, deflate;q=0, identity;q=0"))).toBe(
      "identity",
    );
  });

  if (HAS_ZSTD) {
    it("includes zstd in quality negotiation when supported", () => {
      expect(negotiateEncoding(reqWith("zstd;q=0.2, gzip;q=0.9, identity;q=0"))).toBe("gzip");
      expect(negotiateEncoding(reqWith("zstd;q=0.9, br;q=0.8, identity;q=0"))).toBe("zstd");
    });
  }
});
