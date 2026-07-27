import { describe, expect, it } from "vitest";
import { matchesIfNoneMatch } from "../packages/vinext/src/server/http-conditional.js";

describe("matchesIfNoneMatch", () => {
  it("matches an identical entity tag", () => {
    expect(matchesIfNoneMatch('"asset"', '"asset"')).toBe(true);
  });

  it("uses weak comparison in either direction", () => {
    expect(matchesIfNoneMatch('"asset"', 'W/"asset"')).toBe(true);
    expect(matchesIfNoneMatch('W/"asset"', '"asset"')).toBe(true);
  });

  it("matches a validator within a comma-separated field value", () => {
    expect(matchesIfNoneMatch('"other", W/"asset", "last"', '"asset"')).toBe(true);
  });

  it("does not split commas inside an opaque tag", () => {
    // RFC 9110 permits commas in opaque tags. This is intentionally stricter
    // than Next.js 16.2.7's compiled `fresh` parser, which splits every comma.
    expect(matchesIfNoneMatch('"other", W/"asset,part"', '"asset,part"')).toBe(true);
    expect(matchesIfNoneMatch('"asset,part"', '"asset"')).toBe(false);
  });

  it("treats backslashes as opaque characters rather than escapes", () => {
    expect(matchesIfNoneMatch('W/"asset\\part"', '"asset\\part"')).toBe(true);
  });

  it("matches a wildcard with optional whitespace", () => {
    expect(matchesIfNoneMatch(" \t * \t ", 'W/"asset"')).toBe(true);
  });

  it("rejects a wildcard mixed into an entity-tag list", () => {
    expect(matchesIfNoneMatch('*, "asset"', '"asset"')).toBe(false);
    expect(matchesIfNoneMatch('"other", *', '"asset"')).toBe(false);
  });

  it("does not match different opaque tags or case", () => {
    expect(matchesIfNoneMatch('"other"', '"asset"')).toBe(false);
    expect(matchesIfNoneMatch('"ASSET"', '"asset"')).toBe(false);
  });

  it("does not treat a lowercase weak prefix as W/", () => {
    expect(matchesIfNoneMatch('w/"asset"', '"asset"')).toBe(false);
  });

  it("rejects malformed entity tags", () => {
    expect(matchesIfNoneMatch('asset, "match"', '"match"')).toBe(false);
    expect(matchesIfNoneMatch('"match", garbage', '"match"')).toBe(false);
    expect(matchesIfNoneMatch('"unterminated', '"unterminated"')).toBe(false);
    expect(matchesIfNoneMatch('W/ "asset"', '"asset"')).toBe(false);
    expect(matchesIfNoneMatch('"asset" suffix', '"asset"')).toBe(false);
    expect(matchesIfNoneMatch('"asset\x7fpart"', '"asset\x7fpart"')).toBe(false);
  });

  it("ignores empty list members", () => {
    expect(matchesIfNoneMatch(' , W/"asset", ', '"asset"')).toBe(true);
  });

  it("rejects an invalid current entity tag", () => {
    expect(matchesIfNoneMatch('"asset"', "asset")).toBe(false);
    expect(matchesIfNoneMatch('"asset"', 'W/ "asset"')).toBe(false);
  });

  it("rejects an absent or empty field value", () => {
    expect(matchesIfNoneMatch(undefined, '"asset"')).toBe(false);
    expect(matchesIfNoneMatch("", '"asset"')).toBe(false);
  });
});
