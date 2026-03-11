import { describe, it, expect } from "vitest";
import path from "node:path";
import type { ApiManifest } from "../scripts/extract-nextjs-api.js";
import { diffManifests, loadManifest } from "../scripts/diff-nextjs-api.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures/next-api-manifest");

function makeManifest(modules: Record<string, string[]>, version = "1.0.0"): ApiManifest {
  return {
    version,
    extractedAt: "2026-01-01T00:00:00.000Z",
    modules,
  };
}

describe("diffManifests", () => {
  it("identical manifests produce empty diff", () => {
    const m = makeManifest({ "next/headers": ["cookies", "headers"] });
    const diff = diffManifests(m, m);
    expect(diff.added).toEqual({});
    expect(diff.removed).toEqual({});
    expect(diff.newModules).toEqual([]);
    expect(diff.removedModules).toEqual([]);
  });

  it("detects added exports in existing module", () => {
    const old = makeManifest({ "next/headers": ["cookies"] });
    const updated = makeManifest({
      "next/headers": ["cookies", "draftMode", "headers"],
    });
    const diff = diffManifests(old, updated);
    expect(diff.added).toEqual({
      "next/headers": ["draftMode", "headers"],
    });
    expect(diff.removed).toEqual({});
  });

  it("detects removed exports", () => {
    const old = makeManifest({
      "next/headers": ["cookies", "draftMode", "headers"],
    });
    const updated = makeManifest({ "next/headers": ["cookies"] });
    const diff = diffManifests(old, updated);
    expect(diff.removed).toEqual({
      "next/headers": ["draftMode", "headers"],
    });
    expect(diff.added).toEqual({});
  });

  it("detects entirely new module", () => {
    const old = makeManifest({ "next/headers": ["cookies"] });
    const updated = makeManifest({
      "next/headers": ["cookies"],
      "next/cache": ["revalidateTag"],
    });
    const diff = diffManifests(old, updated);
    expect(diff.newModules).toEqual(["next/cache"]);
    // Added exports for new modules are NOT in `added` (they're in newModules)
    expect(diff.added).toEqual({});
  });

  it("detects entirely removed module", () => {
    const old = makeManifest({
      "next/headers": ["cookies"],
      "next/cache": ["revalidateTag"],
    });
    const updated = makeManifest({ "next/headers": ["cookies"] });
    const diff = diffManifests(old, updated);
    expect(diff.removedModules).toEqual(["next/cache"]);
    expect(diff.removed).toEqual({});
  });

  it("handles simultaneous add+remove across modules", () => {
    const old = makeManifest({
      "next/headers": ["cookies", "draftMode"],
      "next/server": ["NextRequest"],
    });
    const updated = makeManifest({
      "next/headers": ["cookies", "headers"],
      "next/server": ["NextRequest", "NextResponse"],
    });
    const diff = diffManifests(old, updated);
    expect(diff.added).toEqual({
      "next/headers": ["headers"],
      "next/server": ["NextResponse"],
    });
    expect(diff.removed).toEqual({
      "next/headers": ["draftMode"],
    });
  });

  it("sorts results deterministically", () => {
    const old = makeManifest({
      "next/z": ["a"],
      "next/a": ["z"],
    });
    const updated = makeManifest({
      "next/z": ["a"],
      "next/a": ["z"],
      "next/m": ["x"],
      "next/b": ["y"],
    });
    const diff = diffManifests(old, updated);
    expect(diff.newModules).toEqual(["next/b", "next/m"]);
  });

  it("empty manifests produce empty diff", () => {
    const old = makeManifest({});
    const updated = makeManifest({});
    const diff = diffManifests(old, updated);
    expect(diff.added).toEqual({});
    expect(diff.removed).toEqual({});
    expect(diff.newModules).toEqual([]);
    expect(diff.removedModules).toEqual([]);
  });
});

describe("loadManifest", () => {
  it("reads and parses JSON file", () => {
    const manifest = loadManifest(path.join(FIXTURE_DIR, "sample-manifest.json"));
    expect(manifest.version).toBe("99.0.0");
    expect(manifest.modules).toHaveProperty("next/foo");
    expect(manifest.modules["next/foo"]).toEqual(["bar", "baz"]);
  });

  it("throws on invalid JSON", () => {
    // Use a file that definitely isn't valid JSON
    expect(() => loadManifest(path.join(FIXTURE_DIR, "pattern-a/headers.js"))).toThrow();
  });
});
