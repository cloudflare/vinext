import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  extractExportsFromRootFile,
  resolveReExportTarget,
  extractExportsFromDistFile,
  getModuleExports,
  buildManifest,
} from "../scripts/extract-nextjs-api.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures/next-api-manifest");

describe("extractExportsFromRootFile", () => {
  it("extracts Pattern A module.exports.X = ... style exports", () => {
    const source = `
module.exports.cookies = require('./dist/server/request/cookies').cookies
module.exports.headers = require('./dist/server/request/headers').headers
module.exports.draftMode = require('./dist/server/request/draft-mode').draftMode
`;
    const result = extractExportsFromRootFile(source);
    expect(result).toEqual(["cookies", "draftMode", "headers"]);
  });

  it("extracts Pattern A exports.X = ... style exports", () => {
    const source = `
exports.NextRequest = serverExports.NextRequest
exports.NextResponse = serverExports.NextResponse
exports.after = serverExports.after
`;
    const result = extractExportsFromRootFile(source);
    expect(result).toEqual(["NextRequest", "NextResponse", "after"]);
  });

  it("extracts Pattern A cache.js style (object literal then exports)", () => {
    const source = `
const cacheExports = {
  unstable_cache: require('next/dist/server/web/spec-extension/unstable-cache').unstable_cache,
  revalidateTag: require('next/dist/server/web/spec-extension/revalidate').revalidateTag,
  revalidatePath: require('next/dist/server/web/spec-extension/revalidate').revalidatePath,
}

module.exports = cacheExports

exports.unstable_cache = cacheExports.unstable_cache
exports.revalidatePath = cacheExports.revalidatePath
exports.revalidateTag = cacheExports.revalidateTag
`;
    const result = extractExportsFromRootFile(source);
    expect(result).not.toBeNull();
    expect(result).toContain("unstable_cache");
    expect(result).toContain("revalidateTag");
    expect(result).toContain("revalidatePath");
  });

  it("returns null for Pattern B pure re-export", () => {
    const source = `module.exports = require('./dist/client/components/navigation')\n`;
    const result = extractExportsFromRootFile(source);
    expect(result).toBeNull();
  });

  it("returns [] for types-only stub (just throw)", () => {
    const source = `
throw new Error(
  "This module is a placeholder for 'next/root-params' and should be replaced by the compiler."
)
`;
    const result = extractExportsFromRootFile(source);
    expect(result).toEqual([]);
  });

  it("excludes __esModule", () => {
    const source = `
exports.__esModule = true
exports.cookies = require('./dist/cookies').cookies
`;
    const result = extractExportsFromRootFile(source);
    expect(result).toEqual(["cookies"]);
    expect(result).not.toContain("__esModule");
  });
});

describe("resolveReExportTarget", () => {
  it("extracts require path from module.exports = require('./dist/...')", () => {
    const source = `module.exports = require('./dist/client/components/navigation')`;
    expect(resolveReExportTarget(source)).toBe("./dist/client/components/navigation");
  });

  it("returns null for non-re-export", () => {
    const source = `module.exports.cookies = require('./dist/cookies').cookies`;
    expect(resolveReExportTarget(source)).toBeNull();
  });
});

describe("extractExportsFromDistFile", () => {
  it("extracts Pattern B1 dead-code hint exports", () => {
    const source = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
0 && (module.exports = {
    ReadonlyURLSearchParams: null,
    usePathname: null,
    useRouter: null,
    useSearchParams: null
});
`;
    const result = extractExportsFromDistFile(source);
    expect(result).toEqual([
      "ReadonlyURLSearchParams",
      "usePathname",
      "useRouter",
      "useSearchParams",
    ]);
  });

  it("extracts Pattern B3 Object.defineProperty exports", () => {
    const source = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
Object.defineProperty(exports, "default", {
    enumerable: true,
    get: function() { return _default; }
});
`;
    const result = extractExportsFromDistFile(source);
    expect(result).toEqual(["default"]);
  });

  it("extracts Pattern B2 _export block exports", () => {
    const source = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    ReadonlyURLSearchParams: function() { return ReadonlyURLSearchParams; },
    usePathname: function() { return usePathname; },
    useRouter: function() { return useRouter; }
});
`;
    const result = extractExportsFromDistFile(source);
    expect(result).toEqual(["ReadonlyURLSearchParams", "usePathname", "useRouter"]);
  });

  it("deduplicates when B1 + B2 both present", () => {
    const source = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
0 && (module.exports = {
    useRouter: null,
    usePathname: null
});
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    useRouter: function() { return useRouter; },
    usePathname: function() { return usePathname; }
});
`;
    const result = extractExportsFromDistFile(source);
    expect(result).toEqual(["usePathname", "useRouter"]);
  });

  it("excludes __esModule", () => {
    const source = `
Object.defineProperty(exports, "__esModule", { value: true });
0 && (module.exports = {
    __esModule: null,
    useRouter: null
});
`;
    const result = extractExportsFromDistFile(source);
    expect(result).toEqual(["useRouter"]);
    expect(result).not.toContain("__esModule");
  });
});

describe("getModuleExports (integration with fixtures)", () => {
  it("Pattern A fixture returns correct exports", () => {
    const dir = path.join(FIXTURE_DIR, "pattern-a");
    const result = getModuleExports(dir, "headers");
    expect(result).toEqual(["cookies", "draftMode", "headers"]);
  });

  it("Pattern B1 fixture returns correct exports", () => {
    const dir = path.join(FIXTURE_DIR, "pattern-b1");
    const result = getModuleExports(dir, "navigation");
    expect(result).toContain("useRouter");
    expect(result).toContain("usePathname");
    expect(result).toContain("ReadonlyURLSearchParams");
    expect(result).toContain("useSearchParams");
  });

  it("Pattern B2 fixture returns correct exports (default only)", () => {
    const dir = path.join(FIXTURE_DIR, "pattern-b2");
    const result = getModuleExports(dir, "form");
    expect(result).toEqual(["default"]);
  });

  it("returns [] for nonexistent module", () => {
    const dir = path.join(FIXTURE_DIR, "pattern-a");
    const result = getModuleExports(dir, "nonexistent");
    expect(result).toEqual([]);
  });
});

describe("buildManifest", () => {
  it("returns manifest with correct version", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);
    expect(manifest.version).toBe("99.0.0-test");
  });

  it("has all non-empty modules", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);
    // full-package has headers.js, navigation.js, form.js
    expect(manifest.modules).toHaveProperty("next/headers");
    expect(manifest.modules).toHaveProperty("next/navigation");
    expect(manifest.modules).toHaveProperty("next/form");
  });

  it("skips modules with no exports", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);
    // full-package doesn't have server.js, cache.js, etc.
    expect(manifest.modules).not.toHaveProperty("next/server");
    expect(manifest.modules).not.toHaveProperty("next/cache");
  });

  it("exports are sorted alphabetically", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);
    for (const [, exports] of Object.entries(manifest.modules)) {
      const sorted = [...exports].sort();
      expect(exports).toEqual(sorted);
    }
  });

  it("extractedAt is an ISO timestamp", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);
    expect(() => new Date(manifest.extractedAt)).not.toThrow();
    expect(manifest.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
