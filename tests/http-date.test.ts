import { describe, expect, it, vi } from "vitest";
import { parseHttpDate } from "../packages/vinext/src/server/http-date.js";

describe("parseHttpDate", () => {
  const timestamp = Date.parse("2026-01-01T00:00:00Z");

  it("parses all three RFC 9110 HTTP-date formats", () => {
    expect(parseHttpDate("Thu, 01 Jan 2026 00:00:00 GMT")).toBe(timestamp);
    expect(parseHttpDate("Thursday, 01-Jan-26 00:00:00 GMT")).toBe(timestamp);
    expect(parseHttpDate("Thu Jan  1 00:00:00 2026")).toBe(timestamp);
  });

  it("rejects non-HTTP dates and normalized calendar or weekday mistakes", () => {
    expect(parseHttpDate("2026-01-01T00:00:00Z")).toBeNaN();
    expect(parseHttpDate("Sun, 31 Feb 2099 00:00:00 GMT")).toBeNaN();
    expect(parseHttpDate("Fri, 01 Jan 2026 00:00:00 GMT")).toBeNaN();
  });

  it("resolves an RFC 850 year using the full 50-year timestamp boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-27T12:00:00Z");
    try {
      expect(parseHttpDate("Thursday, 31-Dec-76 00:00:00 GMT")).toBeNaN();
      expect(parseHttpDate("Friday, 31-Dec-76 00:00:00 GMT")).toBe(
        Date.parse("1976-12-31T00:00:00Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("adjusts an RFC 850 leap day before validating the inferred century", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-27T12:00:00Z");
    try {
      expect(parseHttpDate("Tuesday, 29-Feb-00 00:00:00 GMT")).toBe(
        Date.parse("2000-02-29T00:00:00Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
