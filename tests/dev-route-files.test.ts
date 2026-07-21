/**
 * Unit tests for the dev-server route-file invalidation predicate.
 *
 * `shouldInvalidateAppRouteFile` decides whether a watched file change must
 * clear the cached app-route graph and metadata scan. It must return true for
 * every file whose add/remove changes the output of those scans — including the
 * `*.alt.txt` sidecars that `scanMetadataFiles` folds into a static social
 * image route's `altFilePath`.
 */
import { describe, it, expect } from "vite-plus/test";
import path from "node:path";
import { shouldInvalidateAppRouteFile } from "../packages/vinext/src/server/dev-route-files.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";

const appDir = path.resolve("/app");
const matcher = createValidFileMatcher();
const inApp = (...segments: string[]) => path.join(appDir, ...segments);

describe("shouldInvalidateAppRouteFile", () => {
  it("invalidates on app-router structure files", () => {
    expect(shouldInvalidateAppRouteFile(appDir, inApp("page.tsx"), matcher)).toBe(true);
    expect(shouldInvalidateAppRouteFile(appDir, inApp("blog", "layout.tsx"), matcher)).toBe(true);
  });

  it("invalidates on primary metadata files (static and dynamic)", () => {
    expect(shouldInvalidateAppRouteFile(appDir, inApp("favicon.ico"), matcher)).toBe(true);
    expect(shouldInvalidateAppRouteFile(appDir, inApp("opengraph-image.png"), matcher)).toBe(true);
    expect(shouldInvalidateAppRouteFile(appDir, inApp("opengraph-image.tsx"), matcher)).toBe(true);
    expect(shouldInvalidateAppRouteFile(appDir, inApp("blog", "twitter-image.jpg"), matcher)).toBe(
      true,
    );
  });

  it("invalidates on opengraph/twitter alt-text sidecars", () => {
    // These are not standalone routes, but scanMetadataFiles resolves them into
    // the image route's `altFilePath`, so add/remove must invalidate the cache.
    expect(shouldInvalidateAppRouteFile(appDir, inApp("opengraph-image.alt.txt"), matcher)).toBe(
      true,
    );
    expect(
      shouldInvalidateAppRouteFile(appDir, inApp("blog", "twitter-image.alt.txt"), matcher),
    ).toBe(true);
    // Numbered image variant sidecar (opengraph-image1.png -> opengraph-image1.alt.txt).
    expect(shouldInvalidateAppRouteFile(appDir, inApp("opengraph-image1.alt.txt"), matcher)).toBe(
      true,
    );
  });

  it("ignores unrelated .alt.txt and plain text files", () => {
    expect(shouldInvalidateAppRouteFile(appDir, inApp("notes.alt.txt"), matcher)).toBe(false);
    expect(shouldInvalidateAppRouteFile(appDir, inApp("readme.txt"), matcher)).toBe(false);
    expect(shouldInvalidateAppRouteFile(appDir, inApp("styles.css"), matcher)).toBe(false);
  });
});
