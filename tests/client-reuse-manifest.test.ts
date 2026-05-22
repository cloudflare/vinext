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
