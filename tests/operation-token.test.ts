import { describe, expect, it } from "vite-plus/test";
import {
  verifyOperationToken,
  verifyOperationTokenForCacheReuse,
  verifyOperationTokenForCommit,
  type OperationToken,
  type OperationTokenAuthority,
  type VerifiedOperationToken,
} from "../packages/vinext/src/server/operation-token.js";

function createToken(overrides: Partial<OperationToken> = {}): OperationToken {
  return {
    operationId: 7,
    lane: "navigation",
    navigationId: 3,
    baseVisibleCommitVersion: 2,
    graphVersion: "graph:test",
    deploymentVersion: null,
    targetSnapshotFingerprint: "route:/dashboard|root:/",
    ...overrides,
  };
}

function createAuthority(
  overrides: Partial<OperationTokenAuthority> = {},
): OperationTokenAuthority {
  return {
    activeNavigationId: 3,
    visibleCommitVersion: 2,
    graphVersion: "graph:test",
    installedCacheVariantFingerprint: null,
    ...overrides,
  };
}

// Compile-time assertion that the verified token narrows to the branded type.
function consumeVerified(_token: VerifiedOperationToken): void {}

describe("verifyOperationTokenForCommit", () => {
  it("authorizes when the navigation and visible-commit dimensions match", () => {
    const token = createToken();
    const verdict = verifyOperationTokenForCommit(token, createAuthority());

    expect(verdict.authorized).toBe(true);
    if (verdict.authorized) {
      // Same evidence object, now carrying the verified brand.
      expect(verdict.token).toBe(token);
      consumeVerified(verdict.token);
    }
  });

  it("rejects staleNavigation when the token started under a superseded navigation", () => {
    const verdict = verifyOperationTokenForCommit(
      createToken({ navigationId: 3 }),
      createAuthority({ activeNavigationId: 4 }),
    );

    expect(verdict).toEqual({ authorized: false, reason: "staleNavigation" });
  });

  it("rejects staleVisibleCommit when visible state advanced after the operation started", () => {
    const verdict = verifyOperationTokenForCommit(
      createToken({ baseVisibleCommitVersion: 2 }),
      createAuthority({ visibleCommitVersion: 3 }),
    );

    expect(verdict).toEqual({ authorized: false, reason: "staleVisibleCommit" });
  });

  it("reports staleNavigation first when both navigation and visible commit diverge", () => {
    const verdict = verifyOperationTokenForCommit(
      createToken({ navigationId: 3, baseVisibleCommitVersion: 2 }),
      createAuthority({ activeNavigationId: 4, visibleCommitVersion: 3 }),
    );

    expect(verdict).toEqual({ authorized: false, reason: "staleNavigation" });
  });

  it("does not gate commits on the cache-variant or graph-version dimensions", () => {
    // A commit eligibility check must not reject on cache/graph divergence; that
    // authority belongs to the cache-reuse boundary and the RSC compatibility path.
    const verdict = verifyOperationTokenForCommit(
      createToken({ graphVersion: "graph:stale", cacheVariantFingerprint: "cv:stale" }),
      createAuthority({
        graphVersion: "graph:fresh",
        installedCacheVariantFingerprint: "cv:fresh",
      }),
    );

    expect(verdict.authorized).toBe(true);
  });
});

describe("verifyOperationTokenForCacheReuse", () => {
  it("authorizes reuse when the graph version matches the installed graph", () => {
    const verdict = verifyOperationTokenForCacheReuse(createToken({ graphVersion: "graph:a" }), {
      graphVersion: "graph:a",
      installedCacheVariantFingerprint: null,
    });

    expect(verdict.authorized).toBe(true);
  });

  it("rejects graphVersionMismatch when the proof was produced under a different graph", () => {
    const verdict = verifyOperationTokenForCacheReuse(createToken({ graphVersion: "graph:a" }), {
      graphVersion: "graph:b",
      installedCacheVariantFingerprint: null,
    });

    expect(verdict).toEqual({ authorized: false, reason: "graphVersionMismatch" });
  });

  it("tolerates an absent graph version rather than rejecting low-context reuse", () => {
    const verdict = verifyOperationTokenForCacheReuse(createToken({ graphVersion: null }), {
      graphVersion: null,
      installedCacheVariantFingerprint: null,
    });

    expect(verdict.authorized).toBe(true);
  });

  it("rejects cacheVariantMismatch when the installed variant differs from the proof", () => {
    const verdict = verifyOperationTokenForCacheReuse(
      createToken({ graphVersion: "graph:a", cacheVariantFingerprint: "cv:a" }),
      { graphVersion: "graph:a", installedCacheVariantFingerprint: "cv:b" },
    );

    expect(verdict).toEqual({ authorized: false, reason: "cacheVariantMismatch" });
  });

  it("tolerates an absent cache-variant fingerprint until segment cache supplies it", () => {
    const verdict = verifyOperationTokenForCacheReuse(
      createToken({ graphVersion: "graph:a", cacheVariantFingerprint: undefined }),
      { graphVersion: "graph:a", installedCacheVariantFingerprint: "cv:b" },
    );

    expect(verdict.authorized).toBe(true);
  });

  it("reports graphVersionMismatch before cacheVariantMismatch when both diverge", () => {
    const verdict = verifyOperationTokenForCacheReuse(
      createToken({ graphVersion: "graph:a", cacheVariantFingerprint: "cv:a" }),
      { graphVersion: "graph:b", installedCacheVariantFingerprint: "cv:b" },
    );

    expect(verdict).toEqual({ authorized: false, reason: "graphVersionMismatch" });
  });
});

describe("verifyOperationToken required dimensions", () => {
  it("fails closed when a required dimension's authority fact is absent", () => {
    // Future segment-cache writes will require the cache-variant dimension. A
    // forgotten fingerprint must reject, not silently pass: absence is not
    // permission.
    const verdict = verifyOperationToken(
      createToken({ cacheVariantFingerprint: undefined }),
      createAuthority({ installedCacheVariantFingerprint: null }),
      { check: ["cacheVariant"], require: ["cacheVariant"] },
    );

    expect(verdict).toEqual({ authorized: false, reason: "cacheVariantMissing" });
  });

  it("rejects a required-but-absent graph version with graphVersionMissing", () => {
    const verdict = verifyOperationToken(
      createToken({ graphVersion: null }),
      createAuthority({ graphVersion: "graph:test" }),
      { check: ["graphVersion"], require: ["graphVersion"] },
    );

    expect(verdict).toEqual({ authorized: false, reason: "graphVersionMissing" });
  });

  it("skips an unchecked dimension entirely even when it diverges", () => {
    const verdict = verifyOperationToken(
      createToken({ graphVersion: "graph:a" }),
      createAuthority({ graphVersion: "graph:b" }),
      { check: ["navigation"], require: ["navigation"] },
    );

    expect(verdict.authorized).toBe(true);
  });

  it("evaluates a required dimension even when it is omitted from check", () => {
    // require implies evaluation: a dimension you require but forget to list in
    // check must still be verified, never silently waved through.
    const verdict = verifyOperationToken(
      createToken({ graphVersion: "graph:a" }),
      createAuthority({ graphVersion: "graph:b" }),
      { check: ["navigation"], require: ["graphVersion"] },
    );

    expect(verdict).toEqual({ authorized: false, reason: "graphVersionMismatch" });
  });
});
