import { describe, expect, it } from "vite-plus/test";
import {
  CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
  CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
  createClientReuseManifest,
  createClientReusePayloadHash,
  DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
  parseClientReuseManifestHeader,
  serializeClientReuseManifest,
} from "../packages/vinext/src/server/client-reuse-manifest.js";
import { createArtifactCompatibilityEnvelope } from "../packages/vinext/src/server/artifact-compatibility.js";
import { AppElementsWire } from "../packages/vinext/src/server/app-elements-wire.js";

const artifactCompatibility = createArtifactCompatibilityEnvelope({
  deploymentVersion: "deploy-a",
  graphVersion: "graph-a",
  renderEpoch: "epoch-a",
  rootBoundaryId: "layout:/",
});

function parseManifest(header: string) {
  const result = parseClientReuseManifestHeader(header);
  expect(result.kind).toBe("parsed");
  if (result.kind !== "parsed") {
    throw new Error("Expected ClientReuseManifest to parse");
  }
  return result;
}

describe("ClientReuseManifest protocol", () => {
  it("treats absent and blank headers as absent manifests", () => {
    for (const header of [null, undefined, "", "   "]) {
      expect(parseClientReuseManifestHeader(header)).toEqual({ kind: "absent" });
    }
  });

  it("parses an empty manifest without enabling skip transport", () => {
    const parsed = parseManifest(
      serializeClientReuseManifest({
        entries: [],
        visibleCommitVersion: 1,
      }),
    );

    expect(parsed.manifest.entries).toEqual([]);
    expect(parsed.entryRejections).toEqual([]);
    expect(parsed.skipDisposition).toEqual({
      code: "SKIP_MODEL_DISABLED",
      enabled: false,
      mode: "renderAndSend",
    });
  });

  it("serializes entries in canonical element-id order", () => {
    const serialized = serializeClientReuseManifest({
      entries: [
        {
          artifactCompatibility,
          id: "layout:/shop",
          payloadHash: createClientReusePayloadHash("shop-layout"),
          privacy: "public",
          variantCacheKey: "cp1:shop",
        },
        {
          artifactCompatibility,
          id: "layout:/",
          payloadHash: createClientReusePayloadHash("root-layout"),
          privacy: "public",
          variantCacheKey: "cp1:root",
        },
      ],
      visibleCommitVersion: 7,
    });

    const parsed = parseManifest(serialized);

    expect(parsed.manifest).toMatchObject({
      hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
      schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
      visibleCommitVersion: 7,
    });
    expect(parsed.manifest.replayWindow).toEqual({
      validFromVisibleCommitVersion: 7,
      validUntilVisibleCommitVersion: 7,
    });
    expect(parsed.manifest.entries.map((entry) => entry.id)).toEqual(["layout:/", "layout:/shop"]);
    expect(parsed.entryRejections).toEqual([]);
    expect(parsed.skipDisposition).toEqual({
      code: "SKIP_MODEL_DISABLED",
      enabled: false,
      mode: "renderAndSend",
    });
  });

  it("serializes duplicate entry IDs once so helper output round-trips", () => {
    const parsed = parseManifest(
      serializeClientReuseManifest({
        entries: [
          {
            artifactCompatibility,
            id: "layout:/",
            payloadHash: createClientReusePayloadHash("root-a"),
            privacy: "public",
            variantCacheKey: "cp1:root-a",
          },
          {
            artifactCompatibility,
            id: "layout:/",
            payloadHash: createClientReusePayloadHash("root-b"),
            privacy: "public",
            variantCacheKey: "cp1:root-b",
          },
          {
            artifactCompatibility,
            id: "layout:/shop",
            payloadHash: createClientReusePayloadHash("shop"),
            privacy: "public",
            variantCacheKey: "cp1:shop",
          },
        ],
        visibleCommitVersion: 1,
      }),
    );

    expect(parsed.manifest.entries).toEqual([
      {
        artifactCompatibility,
        id: "layout:/",
        kind: "layout",
        payloadHash: createClientReusePayloadHash("root-a"),
        privacy: "public",
        variantCacheKey: "cp1:root-a",
      },
      {
        artifactCompatibility,
        id: "layout:/shop",
        kind: "layout",
        payloadHash: createClientReusePayloadHash("shop"),
        privacy: "public",
        variantCacheKey: "cp1:shop",
      },
    ]);
  });

  it("rejects oversized manifests before they can become an IO amplifier", () => {
    const result = parseClientReuseManifestHeader('{"entries":[]}', {
      limits: { ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS, maxManifestBytes: 8 },
    });

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_MANIFEST_TOO_LARGE",
        fields: {
          maxManifestBytes: 8,
          manifestBytes: 14,
        },
      },
    });
  });

  it("counts manifest size in UTF-8 bytes instead of JavaScript string length", () => {
    const header = JSON.stringify({
      entries: [
        {
          artifactCompatibility,
          id: "opaque:😀",
          payloadHash: createClientReusePayloadHash("emoji"),
          privacy: "public",
          variantCacheKey: "cp1:emoji",
        },
      ],
      hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
      replayWindow: {
        validFromVisibleCommitVersion: 1,
        validUntilVisibleCommitVersion: 1,
      },
      schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
      visibleCommitVersion: 1,
    });

    const manifestBytes = new TextEncoder().encode(header).length;
    expect(manifestBytes).toBeGreaterThan(header.length);

    const result = parseClientReuseManifestHeader(header, {
      limits: { ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS, maxManifestBytes: header.length },
    });

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_MANIFEST_TOO_LARGE",
        fields: {
          manifestBytes,
          maxManifestBytes: header.length,
        },
      },
    });
  });

  it("rejects manifests whose entry count exceeds the protocol budget", () => {
    const result = parseClientReuseManifestHeader(
      JSON.stringify({
        entries: [
          {
            artifactCompatibility,
            id: "layout:/",
            payloadHash: createClientReusePayloadHash("root"),
            privacy: "public",
            variantCacheKey: "cp1:root",
          },
          {
            artifactCompatibility,
            id: "layout:/shop",
            payloadHash: createClientReusePayloadHash("shop"),
            privacy: "public",
            variantCacheKey: "cp1:shop",
          },
        ],
        hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
        replayWindow: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: 1,
        },
        schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
        visibleCommitVersion: 1,
      }),
      {
        limits: { ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS, maxEntryCount: 1 },
      },
    );

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_ENTRY_COUNT_EXCEEDED",
        fields: {
          entryCount: 2,
          maxEntryCount: 1,
        },
      },
    });
  });

  it("rejects unsupported hash algorithms instead of accepting unbounded digest work", () => {
    const result = parseClientReuseManifestHeader(
      JSON.stringify({
        entries: [],
        hashAlgorithm: "sha512",
        replayWindow: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: 1,
        },
        schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
        visibleCommitVersion: 1,
      }),
    );

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_HASH_ALGORITHM_UNSUPPORTED",
        fields: { hashAlgorithm: "sha512" },
      },
    });
  });

  it("rejects unsafe visible commit versions from the client boundary", () => {
    const result = parseClientReuseManifestHeader(
      JSON.stringify({
        entries: [],
        hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
        replayWindow: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: 1,
        },
        schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
        visibleCommitVersion: Number.MAX_SAFE_INTEGER + 1,
      }),
    );

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_VISIBLE_COMMIT_VERSION_INVALID",
        fields: { visibleCommitVersion: null },
      },
    });
  });

  it("rejects unsafe replay window bounds from the client boundary", () => {
    const result = parseClientReuseManifestHeader(
      JSON.stringify({
        entries: [],
        hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
        replayWindow: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: Number.MAX_SAFE_INTEGER + 1,
        },
        schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
        visibleCommitVersion: 1,
      }),
    );

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_REPLAY_WINDOW_INVALID",
        fields: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: null,
          visibleCommitVersion: 1,
        },
      },
    });
  });

  it("rejects replayed manifests outside the visible commit version window", () => {
    const manifest = createClientReuseManifest({
      entries: [],
      replayWindow: {
        validFromVisibleCommitVersion: 3,
        validUntilVisibleCommitVersion: 3,
      },
      visibleCommitVersion: 3,
    });

    const result = parseClientReuseManifestHeader(JSON.stringify(manifest), {
      currentVisibleCommitVersion: 4,
    });

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_VISIBLE_COMMIT_VERSION_MISMATCH",
        fields: {
          currentVisibleCommitVersion: 4,
          validFromVisibleCommitVersion: 3,
          validUntilVisibleCommitVersion: 3,
          visibleCommitVersion: 3,
        },
      },
    });
  });

  it("ignores unknown entries and rejects private entries without rejecting known public entries", () => {
    const manifest = createClientReuseManifest({
      entries: [
        {
          artifactCompatibility,
          id: "layout:/",
          payloadHash: createClientReusePayloadHash("root"),
          privacy: "public",
          variantCacheKey: "cp1:root",
        },
        {
          artifactCompatibility,
          id: "opaque:future-entry",
          payloadHash: createClientReusePayloadHash("future"),
          privacy: "public",
          variantCacheKey: "cp1:future",
        },
        {
          artifactCompatibility,
          id: "layout:/account",
          payloadHash: createClientReusePayloadHash("account"),
          privacy: "private",
          variantCacheKey: "cp1:account",
        },
      ],
      visibleCommitVersion: 5,
    });

    const parsed = parseManifest(JSON.stringify(manifest));

    expect(parsed.manifest.entries).toEqual([
      {
        artifactCompatibility,
        id: "layout:/",
        kind: "layout",
        payloadHash: createClientReusePayloadHash("root"),
        privacy: "public",
        variantCacheKey: "cp1:root",
      },
    ]);
    // Rejections preserve their canonical wire position after serialization.
    expect(parsed.entryRejections).toEqual([
      {
        code: "SKIP_PRIVATE_ENTRY",
        entryId: "layout:/account",
        fields: { privacy: "private" },
      },
      {
        code: "SKIP_UNKNOWN_ENTRY",
        entryId: "opaque:future-entry",
        fields: { idHash: createClientReusePayloadHash("opaque:future-entry") },
      },
    ]);
  });

  it("rejects duplicate IDs even when the first copy is rejected per-entry", () => {
    const result = parseClientReuseManifestHeader(
      JSON.stringify({
        entries: [
          {
            artifactCompatibility,
            id: "layout:/account",
            payloadHash: createClientReusePayloadHash("account-private"),
            privacy: "private",
            variantCacheKey: "cp1:account-private",
          },
          {
            artifactCompatibility,
            id: "layout:/account",
            payloadHash: createClientReusePayloadHash("account-public"),
            privacy: "public",
            variantCacheKey: "cp1:account-public",
          },
        ],
        hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
        replayWindow: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: 1,
        },
        schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
        visibleCommitVersion: 1,
      }),
    );

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_ENTRY_ORDER_NON_CANONICAL",
        fields: {
          entryIdHash: createClientReusePayloadHash("layout:/account"),
          previousEntryIdHash: createClientReusePayloadHash("layout:/account"),
        },
      },
    });
  });

  it("accepts intercepted AppElements page and route IDs as public manifest entries", () => {
    const pageId = AppElementsWire.encodePageId("/photos/42", "/feed");
    const routeId = AppElementsWire.encodeRouteId("/api/photos/42", "/feed");
    const parsed = parseManifest(
      serializeClientReuseManifest({
        entries: [
          {
            artifactCompatibility,
            id: pageId,
            payloadHash: createClientReusePayloadHash("page"),
            privacy: "public",
            variantCacheKey: "cp1:page",
          },
          {
            artifactCompatibility,
            id: routeId,
            payloadHash: createClientReusePayloadHash("route"),
            privacy: "public",
            variantCacheKey: "cp1:route",
          },
        ],
        visibleCommitVersion: 1,
      }),
    );

    expect(parsed.manifest.entries).toEqual([
      {
        artifactCompatibility,
        id: pageId,
        kind: "page",
        payloadHash: createClientReusePayloadHash("page"),
        privacy: "public",
        variantCacheKey: "cp1:page",
      },
      {
        artifactCompatibility,
        id: routeId,
        kind: "route",
        payloadHash: createClientReusePayloadHash("route"),
        privacy: "public",
        variantCacheKey: "cp1:route",
      },
    ]);
  });

  it("rejects duplicate entry IDs as non-canonical ordering", () => {
    const result = parseClientReuseManifestHeader(
      JSON.stringify({
        entries: [
          {
            artifactCompatibility,
            id: "layout:/",
            payloadHash: createClientReusePayloadHash("root-a"),
            privacy: "public",
            variantCacheKey: "cp1:root-a",
          },
          {
            artifactCompatibility,
            id: "layout:/",
            payloadHash: createClientReusePayloadHash("root-b"),
            privacy: "public",
            variantCacheKey: "cp1:root-b",
          },
        ],
        hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
        replayWindow: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: 1,
        },
        schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
        visibleCommitVersion: 1,
      }),
    );

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_ENTRY_ORDER_NON_CANONICAL",
        fields: {
          entryIdHash: createClientReusePayloadHash("layout:/"),
          previousEntryIdHash: createClientReusePayloadHash("layout:/"),
        },
      },
    });
  });

  it("rejects non-canonical entry ordering at the manifest boundary", () => {
    const result = parseClientReuseManifestHeader(
      JSON.stringify({
        entries: [
          {
            artifactCompatibility,
            id: "layout:/shop",
            payloadHash: createClientReusePayloadHash("shop"),
            privacy: "public",
            variantCacheKey: "cp1:shop",
          },
          {
            artifactCompatibility,
            id: "layout:/",
            payloadHash: createClientReusePayloadHash("root"),
            privacy: "public",
            variantCacheKey: "cp1:root",
          },
        ],
        hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
        replayWindow: {
          validFromVisibleCommitVersion: 1,
          validUntilVisibleCommitVersion: 1,
        },
        schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
        visibleCommitVersion: 1,
      }),
    );

    expect(result).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_ENTRY_ORDER_NON_CANONICAL",
        fields: {
          entryIdHash: createClientReusePayloadHash("layout:/"),
          previousEntryIdHash: createClientReusePayloadHash("layout:/shop"),
        },
      },
    });
  });
});
