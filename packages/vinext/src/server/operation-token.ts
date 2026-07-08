// OperationToken is the proof-of-eligibility object for App Router navigation.
// It answers one question at every authority boundary: may this navigation
// result enter commit approval or cache reuse? The token only *verifies*;
// `ApprovedVisibleCommit` is the separate proof-of-mutation object that actually
// advances visible router state. Keep that separation: a verified token never
// mutates and never substitutes for the approved-commit brand.
//
// See issue #1790 (PR 5). The token feeds the active-navigation, visible-commit,
// graph-version, and cache-variant checks so commits and cache reuse share one
// authority model instead of deriving eligibility inline in the browser entry.

export type OperationLane =
  | "hmr"
  | "navigation"
  | "prefetch"
  | "refresh"
  | "server-action"
  | "traverse";

export type OperationToken = {
  // Diagnostic only: the per-render operation id (renderId). Distinct from
  // navigationId; not a verification dimension.
  operationId: number;
  // Execution-lane selector. Drives planner behavior (prefetch no-commit, slot
  // persistence); not a verification dimension.
  lane: OperationLane;
  // Authority — active-navigation dimension. The lifecycle navigation id the
  // operation started under, verified against the live activeNavigationId.
  navigationId: number;
  // Authority — visible-commit dimension. The visibleCommitVersion the operation
  // started from, verified against the current visibleCommitVersion.
  baseVisibleCommitVersion: number;
  // Authority — graph-version dimension. The route graph version the operation
  // was planned against, verified against the installed graph version.
  graphVersion: string | null;
  // Future deployment-compatibility dimension: carried for cross-deployment
  // reuse authority but not yet verified by any boundary.
  deploymentVersion: string | null;
  // Diagnostic / future BFCache identity input (PR 6). Not a commit-authority
  // check today.
  targetSnapshotFingerprint: string;
  // Authority — cache-variant dimension. The cache variant that produced the
  // result, verified against the installed variant. Populated once segment cache
  // variant keys exist (PR 7); absent until then.
  cacheVariantFingerprint?: string;
};

// A token that has passed `verifyOperationToken`. Boundaries that consume proof
// (not raw evidence) accept this branded type so an unverified token cannot
// reach them by construction. Mirrors the ApprovedVisibleCommit brand pattern
// without collapsing verification and mutation into one object.
declare const verifiedOperationTokenBrand: unique symbol;
export type VerifiedOperationToken = OperationToken & {
  readonly [verifiedOperationTokenBrand]: true;
};

// The live authority facts a boundary checks the token against. Each field is
// the *current* installed/active value; the token carries the value it was
// minted with. graphVersion / installedCacheVariantFingerprint are nullable
// because low-context paths (absent route manifest, pre-segment-cache reuse) may
// not carry them.
export type OperationTokenAuthority = {
  activeNavigationId: number;
  visibleCommitVersion: number;
  graphVersion: string | null;
  installedCacheVariantFingerprint: string | null;
};

type OperationTokenDimension = "navigation" | "visibleCommit" | "graphVersion" | "cacheVariant";

export type OperationTokenRejectionReason =
  | "staleNavigation"
  | "staleVisibleCommit"
  | "graphVersionMismatch"
  | "graphVersionMissing"
  | "cacheVariantMismatch"
  | "cacheVariantMissing";

export type OperationTokenVerdict =
  | { readonly authorized: true; readonly token: VerifiedOperationToken }
  | { readonly authorized: false; readonly reason: OperationTokenRejectionReason };

// Per-dimension verification policy. `check` is the set of dimensions a boundary
// evaluates; `require` is the subset whose authority fact must be present.
//
// The two-level shape is deliberate, not redundant: a *checked* dimension that
// is absent is tolerated (low-context paths must keep working), but a *required*
// dimension that is absent fails closed. Absence must never silently become
// permission — that is how proof systems rot. Required-but-absent is reserved
// for the future segment-cache / BFCache write boundaries (PR 6/7), where a
// forgotten fingerprint must reject.
export type OperationTokenVerificationPolicy = {
  check: readonly OperationTokenDimension[];
  require: readonly OperationTokenDimension[];
};

// Fixed evaluation order so the reported rejection reason is deterministic
// regardless of the order a caller lists `check`.
const DIMENSION_ORDER: readonly OperationTokenDimension[] = [
  "navigation",
  "visibleCommit",
  "graphVersion",
  "cacheVariant",
];

type DimensionStatus =
  | { kind: "satisfied" }
  | { kind: "mismatch"; reason: OperationTokenRejectionReason }
  | { kind: "absent"; missingReason: OperationTokenRejectionReason };

function evaluateDimension(
  dimension: OperationTokenDimension,
  token: OperationToken,
  authority: OperationTokenAuthority,
): DimensionStatus {
  switch (dimension) {
    case "navigation":
      // navigationId is always present (a number), so this dimension is never absent.
      return token.navigationId === authority.activeNavigationId
        ? { kind: "satisfied" }
        : { kind: "mismatch", reason: "staleNavigation" };
    case "visibleCommit":
      return token.baseVisibleCommitVersion === authority.visibleCommitVersion
        ? { kind: "satisfied" }
        : { kind: "mismatch", reason: "staleVisibleCommit" };
    case "graphVersion": {
      if (token.graphVersion === null || authority.graphVersion === null) {
        return { kind: "absent", missingReason: "graphVersionMissing" };
      }
      return token.graphVersion === authority.graphVersion
        ? { kind: "satisfied" }
        : { kind: "mismatch", reason: "graphVersionMismatch" };
    }
    case "cacheVariant": {
      const tokenVariant = token.cacheVariantFingerprint;
      const installedVariant = authority.installedCacheVariantFingerprint;
      if (tokenVariant === undefined || installedVariant === null) {
        return { kind: "absent", missingReason: "cacheVariantMissing" };
      }
      return tokenVariant === installedVariant
        ? { kind: "satisfied" }
        : { kind: "mismatch", reason: "cacheVariantMismatch" };
    }
    default: {
      const _exhaustive: never = dimension;
      throw new Error("[vinext] Unknown operation-token dimension: " + String(_exhaustive));
    }
  }
}

export function verifyOperationToken(
  token: OperationToken,
  authority: OperationTokenAuthority,
  policy: OperationTokenVerificationPolicy,
): OperationTokenVerdict {
  const required = new Set(policy.require);
  // A required dimension is always evaluated, even if a caller forgot to also
  // list it in `check`. Requiring a dimension you never evaluate would let its
  // absence pass silently — the exact failure mode this two-level policy exists
  // to prevent — so `require` implies evaluation.
  const evaluated = new Set([...policy.check, ...policy.require]);

  for (const dimension of DIMENSION_ORDER) {
    if (!evaluated.has(dimension)) continue;
    const status = evaluateDimension(dimension, token, authority);
    if (status.kind === "mismatch") {
      return { authorized: false, reason: status.reason };
    }
    if (status.kind === "absent" && required.has(dimension)) {
      return { authorized: false, reason: status.missingReason };
    }
  }

  // The verifier is the only place that mints the verified brand: the raw token
  // is evidence, the returned token is proof.
  return { authorized: true, token: token as VerifiedOperationToken };
}

// Commit eligibility. Commits gate on the lifecycle dimensions the browser owns
// (which navigation is active, which visible commit it started from). They do
// not gate on cache variant, and graph-version enforcement for commits remains
// the RSC artifact-compatibility path's job — so neither is checked here.
export function verifyOperationTokenForCommit(
  token: OperationToken,
  authority: Pick<OperationTokenAuthority, "activeNavigationId" | "visibleCommitVersion">,
): OperationTokenVerdict {
  return verifyOperationToken(
    token,
    {
      activeNavigationId: authority.activeNavigationId,
      visibleCommitVersion: authority.visibleCommitVersion,
      // Unchecked for commits; echo the token so the facts are consistent.
      graphVersion: token.graphVersion,
      installedCacheVariantFingerprint: token.cacheVariantFingerprint ?? null,
    },
    { check: ["navigation", "visibleCommit"], require: ["navigation", "visibleCommit"] },
  );
}

// Cache-reuse eligibility. Reuse gates on the payload-vs-installed dimensions the
// planner owns: the graph version the proof was produced under and the cache
// variant that produced it. Both are tolerated when absent today (the route
// manifest may be null; segment cache variant keys arrive in PR 7) and reject
// only on genuine divergence — behavior-preserving for current single-document
// reuse, a real guard once cross-document/segment reuse can diverge.
export function verifyOperationTokenForCacheReuse(
  token: OperationToken,
  authority: Pick<OperationTokenAuthority, "graphVersion" | "installedCacheVariantFingerprint">,
): OperationTokenVerdict {
  return verifyOperationToken(
    token,
    {
      // Unchecked for cache reuse; echo the token so the lifecycle facts are
      // consistent (the pre-planner commit gate already owns those dimensions).
      activeNavigationId: token.navigationId,
      visibleCommitVersion: token.baseVisibleCommitVersion,
      graphVersion: authority.graphVersion,
      installedCacheVariantFingerprint: authority.installedCacheVariantFingerprint,
    },
    { check: ["graphVersion", "cacheVariant"], require: [] },
  );
}
