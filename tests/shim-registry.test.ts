import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  PUBLIC_SHIMS,
  INTERNAL_SHIMS,
  VINEXT_SHIMS_DIR_ENTRIES,
  VINEXT_SERVER_ENTRIES,
  buildShimMap,
} from "../packages/vinext/src/shims/registry";

describe("shim registry", () => {
  // 1. PUBLIC_SHIMS has the right number of entries
  it("PUBLIC_SHIMS contains 23 entries with correct keys", () => {
    expect(Object.keys(PUBLIC_SHIMS)).toHaveLength(23);
    expect(PUBLIC_SHIMS["next/link"]).toBe("link");
    expect(PUBLIC_SHIMS["next/navigation"]).toBe("navigation");
    expect(PUBLIC_SHIMS["next/headers"]).toBe("headers");
  });

  // 2. buildShimMap produces absolute paths
  it("buildShimMap produces absolute paths for all entries", () => {
    const map = buildShimMap("/fake/shims", "/fake/src");
    // All values should be absolute paths
    for (const [key, value] of Object.entries(map)) {
      expect(path.isAbsolute(value), `${key} -> ${value} should be absolute`).toBe(true);
    }
  });

  // 3. User aliases are overridden by vinext mappings
  it("user aliases are overridden by vinext mappings", () => {
    const map = buildShimMap("/fake/shims", "/fake/src", {
      "next/link": "/user/custom/link",
      "custom/thing": "/user/custom/thing",
    });
    // vinext mapping wins
    expect(map["next/link"]).toBe("/fake/shims/link");
    // user-only alias preserved
    expect(map["custom/thing"]).toBe("/user/custom/thing");
  });

  // 4. Total entry count
  it("total entry count across all categories is 46", () => {
    const total =
      Object.keys(PUBLIC_SHIMS).length +
      Object.keys(INTERNAL_SHIMS).length +
      Object.keys(VINEXT_SHIMS_DIR_ENTRIES).length +
      Object.keys(VINEXT_SERVER_ENTRIES).length;
    expect(total).toBe(48);
  });

  // 5. All shim file targets exist on disk
  it("all shim file targets exist on disk", () => {
    const shimsDir = path.resolve(import.meta.dirname, "../packages/vinext/src/shims");
    const srcDir = path.resolve(import.meta.dirname, "../packages/vinext/src");

    const allEntries = {
      ...PUBLIC_SHIMS,
      ...INTERNAL_SHIMS,
      ...VINEXT_SHIMS_DIR_ENTRIES,
    };

    for (const [key, relPath] of Object.entries(allEntries)) {
      const fullPath = path.join(shimsDir, relPath);
      const exists =
        fs.existsSync(fullPath + ".ts") ||
        fs.existsSync(fullPath + ".tsx") ||
        fs.existsSync(fullPath + "/index.ts");
      expect(exists, `Shim target for "${key}" not found at ${fullPath}`).toBe(true);
    }

    for (const [key, relPath] of Object.entries(VINEXT_SERVER_ENTRIES)) {
      const fullPath = path.resolve(srcDir, relPath);
      const exists = fs.existsSync(fullPath + ".ts") || fs.existsSync(fullPath + ".tsx");
      expect(exists, `Server entry for "${key}" not found at ${fullPath}`).toBe(true);
    }
  });
});
