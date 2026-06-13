import { describe, expect, it } from "vite-plus/test";
import { createArtifactCompatibilityEnvelope } from "../packages/vinext/src/server/artifact-compatibility.js";
import { createClientReuseManifestHeaderFromVisibleAppState } from "../packages/vinext/src/server/app-browser-client-reuse-manifest.js";
import { AppElementsWire } from "../packages/vinext/src/server/app-elements.js";
import {
  CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET,
  DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
  parseClientReuseManifestHeader,
} from "../packages/vinext/src/server/client-reuse-manifest.js";

function createVisibleState(input: {
  extraEntries?: Record<string, unknown>;
  graphVersion?: string;
  layoutFlags: Record<string, "s" | "d">;
  layoutIds: readonly string[];
  routeId?: string;
  visibleCommitVersion?: number;
}) {
  const artifactCompatibility = createArtifactCompatibilityEnvelope({
    deploymentVersion: "deploy:test",
    graphVersion: input.graphVersion ?? "graph:test",
    rootBoundaryId: "/",
  });
  return {
    elements: {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: input.layoutIds,
        rootLayoutTreePath: "/",
        routeId: input.routeId ?? "route:/current",
      }),
      [AppElementsWire.keys.artifactCompatibility]: artifactCompatibility,
      [AppElementsWire.keys.layoutFlags]: input.layoutFlags,
      ...input.extraEntries,
    },
    visibleCommitVersion: input.visibleCommitVersion ?? 4,
  };
}

describe("app browser client reuse manifest", () => {
  it("builds a public manifest only for retained static layout entries", () => {
    const header = createClientReuseManifestHeaderFromVisibleAppState(
      createVisibleState({
        extraEntries: {
          "layout:/": "root layout",
          "layout:/dynamic": "dynamic layout",
          "page:/current": "page",
        },
        layoutFlags: {
          "layout:/": "s",
          "layout:/dynamic": "d",
          "layout:/missing": "s",
        },
        layoutIds: ["layout:/", "layout:/dynamic", "layout:/missing"],
      }),
    );

    const parsed = parseClientReuseManifestHeader(header);

    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") {
      throw new Error("Expected client reuse manifest to parse");
    }
    expect(parsed.manifest.visibleCommitVersion).toBe(4);
    expect(parsed.manifest.replayWindow).toEqual({
      validFromVisibleCommitVersion: 4,
      validUntilVisibleCommitVersion: 4,
    });
    expect(parsed.manifest.entries.map((entry) => entry.id)).toEqual(["layout:/"]);
    expect(parsed.manifest.entries[0]).toMatchObject({
      kind: "layout",
      privacy: "public",
    });
  });

  it("keeps retained static layout proofs stable across source routes", () => {
    function readLayoutEntry(routeId: string, graphVersion: string) {
      const header = createClientReuseManifestHeaderFromVisibleAppState(
        createVisibleState({
          extraEntries: { "layout:/dashboard": "dashboard layout" },
          graphVersion,
          layoutFlags: { "layout:/dashboard": "s" },
          layoutIds: ["layout:/dashboard"],
          routeId,
        }),
      );
      const parsed = parseClientReuseManifestHeader(header);
      expect(parsed.kind).toBe("parsed");
      if (parsed.kind !== "parsed") {
        throw new Error("Expected client reuse manifest to parse");
      }
      return parsed.manifest.entries[0];
    }

    const settingsEntry = readLayoutEntry("route:/dashboard/settings", "graph:settings");
    const profileEntry = readLayoutEntry("route:/dashboard/profile", "graph:profile");

    expect(settingsEntry).toEqual(profileEntry);
  });

  it("trims entries rather than emitting an oversized manifest header", () => {
    const layoutIds = Array.from({ length: 12 }, (_, index) => `layout:/section-${index}`);
    const header = createClientReuseManifestHeaderFromVisibleAppState(
      createVisibleState({
        extraEntries: Object.fromEntries(layoutIds.map((layoutId) => [layoutId, layoutId])),
        layoutFlags: Object.fromEntries(layoutIds.map((layoutId) => [layoutId, "s"])),
        layoutIds,
      }),
      {
        limits: {
          ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
          maxManifestBytes: 900,
        },
      },
    );

    expect(header).not.toBeNull();
    expect(new TextEncoder().encode(header!).length).toBeLessThanOrEqual(900);

    const parsed = parseClientReuseManifestHeader(header, {
      limits: {
        ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
        maxManifestBytes: 900,
      },
    });
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") {
      throw new Error("Expected trimmed client reuse manifest to parse");
    }
    expect(parsed.manifest.entries.length).toBeGreaterThan(0);
    expect(parsed.manifest.entries.length).toBeLessThan(layoutIds.length);
  });

  it("caps default browser manifests to the server skip verification budget", () => {
    const layoutIds = Array.from(
      { length: CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET + 4 },
      (_, index) => `layout:/section-${index}`,
    );
    const header = createClientReuseManifestHeaderFromVisibleAppState(
      createVisibleState({
        extraEntries: Object.fromEntries(layoutIds.map((layoutId) => [layoutId, layoutId])),
        layoutFlags: Object.fromEntries(layoutIds.map((layoutId) => [layoutId, "s"])),
        layoutIds,
      }),
      {
        limits: {
          ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
          maxManifestBytes: 16_000,
        },
      },
    );

    const parsed = parseClientReuseManifestHeader(header, {
      limits: {
        ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
        maxManifestBytes: 16_000,
      },
    });

    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") {
      throw new Error("Expected capped client reuse manifest to parse");
    }
    expect(parsed.manifest.entries.map((entry) => entry.id)).toEqual(
      layoutIds.slice(0, CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET),
    );
  });
});
