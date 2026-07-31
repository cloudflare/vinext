import { describe, expect, it } from "vitest";
import {
  evaluateStaticPreconditions,
  matchesIfMatch,
  matchesIfNoneMatch,
} from "../packages/vinext/src/server/http-conditional.js";

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

describe("matchesIfMatch", () => {
  it("matches weak and strong variants like Next.js static serving", () => {
    expect(matchesIfMatch('"asset"', '"asset"')).toBe(true);
    expect(matchesIfMatch('W/"asset"', '"asset"')).toBe(true);
    expect(matchesIfMatch('"asset"', 'W/"asset"')).toBe(true);
    expect(matchesIfMatch('W/"asset"', 'W/"asset"')).toBe(true);
    expect(matchesIfMatch('W/"other"', 'W/"asset"')).toBe(false);
  });

  it("matches strong tags containing commas inside a list", () => {
    expect(matchesIfMatch('"other", "asset,part"', '"asset,part"')).toBe(true);
  });

  it("matches a standalone wildcard when the representation exists", () => {
    expect(matchesIfMatch(" \t * \t ", undefined)).toBe(true);
    expect(matchesIfMatch('*, "asset"', '"asset"')).toBe(false);
  });

  it("rejects malformed entity-tag lists", () => {
    expect(matchesIfMatch('asset, "match"', '"match"')).toBe(false);
    expect(matchesIfMatch('"unterminated', '"unterminated"')).toBe(false);
  });
});

describe("evaluateStaticPreconditions", () => {
  const mtimeMs = Date.parse("2026-07-26T12:34:56.789Z");

  it("uses If-None-Match before If-Modified-Since", () => {
    expect(
      evaluateStaticPreconditions(
        {
          ifNoneMatch: '"different"',
          ifModifiedSince: "Mon, 27 Jul 2026 12:34:56 GMT",
        },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("proceed");
  });

  it("matches If-Modified-Since at whole-second precision", () => {
    expect(
      evaluateStaticPreconditions(
        { ifModifiedSince: "Sun, 26 Jul 2026 12:34:56 GMT" },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("not-modified");
    expect(
      evaluateStaticPreconditions(
        { ifModifiedSince: "Sun, 26 Jul 2026 12:34:55 GMT" },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("proceed");
  });

  it("ignores malformed and normalized-invalid modification dates", () => {
    expect(
      evaluateStaticPreconditions({ ifModifiedSince: "not a date" }, "GET", '"asset"', mtimeMs),
    ).toBe("proceed");
    expect(
      evaluateStaticPreconditions(
        { ifModifiedSince: "Tue, 31 Feb 2026 12:34:56 GMT" },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("proceed");
    expect(
      evaluateStaticPreconditions(
        { ifModifiedSince: "Mon, 26 Jul 2026 12:34:56 GMT" },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("proceed");
  });

  it("honors Cache-Control: no-cache despite matching freshness validators", () => {
    expect(
      evaluateStaticPreconditions(
        {
          cacheControl: "max-age=0, No-Cache",
          ifNoneMatch: 'W/"asset"',
          ifModifiedSince: "Mon, 27 Jul 2026 12:34:56 GMT",
        },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("proceed");
  });

  it("evaluates If-Match before If-Unmodified-Since", () => {
    expect(
      evaluateStaticPreconditions(
        {
          ifMatch: '"asset"',
          ifUnmodifiedSince: "Sat, 25 Jul 2026 12:34:56 GMT",
        },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("proceed");
    expect(evaluateStaticPreconditions({ ifMatch: '"different"' }, "GET", '"asset"', mtimeMs)).toBe(
      "precondition-failed",
    );
  });

  it("fails If-Unmodified-Since when the representation changed later", () => {
    expect(
      evaluateStaticPreconditions(
        { ifUnmodifiedSince: "Sun, 26 Jul 2026 12:34:55 GMT" },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("precondition-failed");
  });

  it("ignores an invalid If-Unmodified-Since date", () => {
    expect(
      evaluateStaticPreconditions(
        { ifUnmodifiedSince: "Tue, 31 Feb 2026 12:34:56 GMT" },
        "GET",
        '"asset"',
        mtimeMs,
      ),
    ).toBe("proceed");
  });

  it("ignores If-Unmodified-Since without a valid current modification date", () => {
    expect(
      evaluateStaticPreconditions(
        { ifUnmodifiedSince: "Thu, 01 Jan 1970 00:00:00 GMT" },
        "GET",
        '"asset"',
        Number.NaN,
      ),
    ).toBe("proceed");
  });

  it("uses 412 rather than 304 for matching If-None-Match on unsafe methods", () => {
    expect(
      evaluateStaticPreconditions({ ifNoneMatch: 'W/"asset"' }, "POST", '"asset"', mtimeMs),
    ).toBe("precondition-failed");
  });
});
