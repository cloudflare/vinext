import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  extractExportsFromRootFile,
  resolveReExportTarget,
  extractExportsFromDistFile,
  discoverPublicEntrypoints,
  getModuleExports,
  buildManifest,
} from "../scripts/extract-nextjs-api.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures/next-api-manifest");

describe("discoverPublicEntrypoints", () => {
  it("discovers root and nested public entry files without a hard-coded module list", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const discovered = discoverPublicEntrypoints(dir);

    expect(discovered.map((entry) => entry.specifier)).toEqual([
      "next/babel",
      "next/compat/router",
      "next/experimental/testmode/proxy",
      "next/font/google",
      "next/font/local",
      "next/form",
      "next/headers",
      "next/legacy/image",
      "next/navigation",
      "next/web-vitals",
    ]);
  });

  it("records entryFile paths relative to the package root", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const discovered = discoverPublicEntrypoints(dir);
    expect(discovered.find((entry) => entry.specifier === "next/compat/router")?.entryFile).toBe(
      "compat/router.js",
    );
    expect(
      discovered.find((entry) => entry.specifier === "next/experimental/testmode/proxy")?.entryFile,
    ).toBe("experimental/testmode/proxy.js");
  });

  it("skips dist/ files from discovery", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const discovered = discoverPublicEntrypoints(dir);
    expect(discovered.some((entry) => entry.entryFile.startsWith("dist/"))).toBe(false);
  });
});

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

  it("resolves subdirectory module with custom entryFile", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const result = getModuleExports(dir, "compat/router", "compat/router.js");
    expect(result).toEqual(["useRouter"]);
  });

  it("resolves subdirectory module with default export", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const result = getModuleExports(dir, "legacy/image", "legacy/image.js");
    expect(result).toEqual(["default"]);
  });

  it("returns [] for empty subdirectory entry file", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const result = getModuleExports(dir, "font/google", "font/google/index.js");
    expect(result).toEqual([]);
  });

  it("resolves newly discovered root modules outside the previous allowlist", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const result = getModuleExports(dir, "babel", "babel.js");
    expect(result).toEqual(["default"]);
  });

  it("resolves re-export targets that point at a directory index", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const result = getModuleExports(
      dir,
      "experimental/testmode/proxy",
      "experimental/testmode/proxy.js",
    );
    expect(result).toEqual(["createProxyServer"]);
  });
});

describe("buildManifest", () => {
  it("returns manifest with correct version", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);
    expect(manifest.version).toBe("99.0.0-test");
  });

  it("has all non-empty modules including subdirectory modules", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);

    expect(manifest.modules).toHaveProperty("next/headers");
    expect(manifest.modules).toHaveProperty("next/navigation");
    expect(manifest.modules).toHaveProperty("next/form");
    expect(manifest.modules).toHaveProperty("next/web-vitals");
    expect(manifest.modules).toHaveProperty("next/babel");
    expect(manifest.modules).toHaveProperty("next/compat/router");
    expect(manifest.modules).toHaveProperty("next/experimental/testmode/proxy");
    expect(manifest.modules).toHaveProperty("next/legacy/image");

    expect(manifest.modules["next/babel"]).toEqual(["default"]);
    expect(manifest.modules["next/compat/router"]).toEqual(["useRouter"]);
    expect(manifest.modules["next/experimental/testmode/proxy"]).toEqual(["createProxyServer"]);
    expect(manifest.modules["next/legacy/image"]).toEqual(["default"]);
    expect(manifest.modules["next/web-vitals"]).toEqual(["useReportWebVitals"]);
  });

  it("skips modules with no exports including empty subdirectory entries", () => {
    const dir = path.join(FIXTURE_DIR, "full-package");
    const manifest = buildManifest(dir);
    // full-package doesn't have server.js, cache.js, etc.
    expect(manifest.modules).not.toHaveProperty("next/server");
    expect(manifest.modules).not.toHaveProperty("next/cache");
    // font/google and font/local have empty entry files
    expect(manifest.modules).not.toHaveProperty("next/font/google");
    expect(manifest.modules).not.toHaveProperty("next/font/local");
    expect(manifest.modules).not.toHaveProperty("next/root-params");
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
