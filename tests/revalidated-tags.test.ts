import { describe, expect, it } from "vite-plus/test";
import {
  readPreviouslyRevalidatedTags,
  writePreviouslyRevalidatedTags,
} from "../packages/vinext/src/server/revalidated-tags.js";
import {
  NEXT_CACHE_REVALIDATED_TAGS_HEADER,
  NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER,
  VINEXT_CACHE_REVALIDATED_TAGS_HEADER,
} from "../packages/vinext/src/server/headers.js";

describe("forwarded cache revalidation tags", () => {
  it("round-trips unique tags with the authenticated internal protocol", () => {
    const headers = new Headers();
    writePreviouslyRevalidatedTags(headers, ["posts", "users", "posts"], "draft-secret");

    expect(headers.get(NEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe("posts,users");
    expect(headers.get(VINEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe('["posts","users"]');
    expect(headers.get(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER)).toBe("draft-secret");
    expect(readPreviouslyRevalidatedTags(headers, "draft-secret")).toEqual(["posts", "users"]);
  });

  it("round-trips tags containing commas without splitting them", () => {
    const headers = new Headers();
    writePreviouslyRevalidatedTags(headers, ["tenant,42", "posts"], "draft-secret");

    expect(readPreviouslyRevalidatedTags(headers, "draft-secret")).toEqual(["tenant,42", "posts"]);
  });

  it("does not reinterpret a JSON-looking tag from the legacy header", () => {
    const headers = new Headers({
      [NEXT_CACHE_REVALIDATED_TAGS_HEADER]: '["posts"]',
      [NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER]: "draft-secret",
    });

    expect(readPreviouslyRevalidatedTags(headers, "draft-secret")).toEqual(['["posts"]']);
  });

  it("falls back to the legacy header when the JSON side channel is malformed", () => {
    const headers = new Headers({
      [NEXT_CACHE_REVALIDATED_TAGS_HEADER]: "posts,users",
      [NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER]: "draft-secret",
      [VINEXT_CACHE_REVALIDATED_TAGS_HEADER]: "not-json",
    });

    expect(readPreviouslyRevalidatedTags(headers, "draft-secret")).toEqual(["posts", "users"]);
  });

  it("rejects forged tags with a missing or mismatched token", () => {
    const headers = new Headers({
      [NEXT_CACHE_REVALIDATED_TAGS_HEADER]: "posts",
      [NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER]: "attacker-token",
    });

    expect(readPreviouslyRevalidatedTags(headers, "draft-secret")).toEqual([]);
    expect(readPreviouslyRevalidatedTags(headers, "")).toEqual([]);
  });

  it("accepts the legacy comma-delimited form during mixed-version requests", () => {
    const headers = new Headers({
      [NEXT_CACHE_REVALIDATED_TAGS_HEADER]: "posts,users,posts",
      [NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER]: "draft-secret",
    });

    expect(readPreviouslyRevalidatedTags(headers, "draft-secret")).toEqual(["posts", "users"]);
  });

  it("does not emit forwarding headers without tags or a token", () => {
    const missingTags = new Headers();
    writePreviouslyRevalidatedTags(missingTags, [], "draft-secret");
    expect(missingTags.has(NEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe(false);
    expect(missingTags.has(VINEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe(false);

    const missingToken = new Headers();
    writePreviouslyRevalidatedTags(missingToken, ["posts"], "");
    expect(missingToken.has(NEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe(false);
    expect(missingToken.has(VINEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe(false);
  });
});
