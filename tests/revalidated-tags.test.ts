import { describe, expect, it } from "vite-plus/test";
import {
  readPreviouslyRevalidatedTags,
  writePreviouslyRevalidatedTags,
} from "../packages/vinext/src/server/revalidated-tags.js";
import {
  NEXT_CACHE_REVALIDATED_TAGS_HEADER,
  NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER,
} from "../packages/vinext/src/server/headers.js";

describe("forwarded cache revalidation tags", () => {
  it("round-trips unique tags with the authenticated internal protocol", () => {
    const headers = new Headers();
    writePreviouslyRevalidatedTags(headers, ["posts", "users", "posts"], "draft-secret");

    expect(headers.get(NEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe("posts,users");
    expect(headers.get(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER)).toBe("draft-secret");
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

  it("does not emit forwarding headers without tags or a token", () => {
    const missingTags = new Headers();
    writePreviouslyRevalidatedTags(missingTags, [], "draft-secret");
    expect(missingTags.has(NEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe(false);

    const missingToken = new Headers();
    writePreviouslyRevalidatedTags(missingToken, ["posts"], "");
    expect(missingToken.has(NEXT_CACHE_REVALIDATED_TAGS_HEADER)).toBe(false);
  });
});
