/**
 * Deterministic in-process "data edge". Stands in for the federated data
 * layer: every op resolves locally with a small artificial latency so async
 * data-fetch paths in getServerSideProps and getInitialProps stay realistic.
 */

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type AssetCard = {
  assetId: string;
  collection: string;
  title: string;
  kind: string;
};

export type AssetRecord = AssetCard & {
  summary: string;
  /** Set when the asset has been withdrawn — its URLs must 404. */
  retiredOn?: string;
  /** Pack assets bundle other asset ids. */
  bundle?: string[];
};

const KNOWN_WALLS = ["skies", "tides", "forests"] as const;

/**
 * The whole catalogue, keyed by id. Kinds live on the record — nothing about
 * an id's shape encodes what the asset is.
 */
const CATALOGUE = new Map<string, AssetRecord>();

KNOWN_WALLS.forEach((wall, wallIndex) => {
  for (let i = 0; i < 4; i++) {
    const assetId = String(1000 + (wallIndex + 1) * 100 + i + 1);
    CATALOGUE.set(assetId, {
      assetId,
      collection: wall,
      title: `${wall[0].toUpperCase()}${wall.slice(1)} asset ${i}`,
      kind: wallIndex === 1 ? "track" : "clip",
      summary: `A ${wall} catalogue entry.`,
    });
  }
});

CATALOGUE.set("3001", {
  assetId: "3001",
  collection: "boxed-set",
  title: "Boxed set",
  kind: "pack",
  summary: "A bundle of other assets.",
  bundle: ["1101", "1201"],
});

CATALOGUE.set("1999", {
  assetId: "1999",
  collection: "skies",
  title: "Withdrawn asset",
  kind: "clip",
  summary: "No longer available.",
  retiredOn: "2025-03-01",
});

const wallAssets = (wall: string): AssetCard[] =>
  [...CATALOGUE.values()]
    .filter((record) => record.collection === wall && !record.retiredOn)
    .map(({ assetId, collection, title, kind }) => ({
      assetId,
      collection,
      title,
      kind,
    }));

type OpVars = Record<string, unknown>;

const ops: Record<string, (vars: OpVars) => unknown> = {
  frontDoorFeed: (vars) => ({
    heading: `Welcome to the ${String(vars.zoneId)} atlas`,
    modules: ["hero", "grid"],
    featured: wallAssets("skies").slice(0, 2),
  }),
  nodeByTrail: (vars) => {
    const leaf = String(vars.trail ?? "")
      .split("/")
      .filter(Boolean)
      .pop();
    if (!KNOWN_WALLS.includes(leaf as (typeof KNOWN_WALLS)[number])) {
      return null;
    }
    return {
      nodeRef: `node-${leaf}`,
      name: leaf,
      assets: wallAssets(leaf!),
    };
  },
  assetById: (vars) => CATALOGUE.get(String(vars.assetId ?? "")) ?? null,
  broadcastFor: (vars) => ({
    slot: String(vars.slot),
    message: `${String(vars.slot)} broadcast for ${(vars.audiences as string[]).join(",")}`,
    draft: Boolean(vars.draft),
  }),
  lookupAssets: (vars) => {
    const term = String(vars.term ?? "");
    return {
      term,
      total: term.length,
      matches: wallAssets("forests").map((asset) => ({
        ...asset,
        title: `${asset.title} (${term})`,
      })),
    };
  },
  provisioningFor: (vars) => [
    { key: "standard", zoneId: String(vars.zoneId) },
    { key: "expedited", zoneId: String(vars.zoneId) },
  ],
};

export const executeGraphOp = async (
  op: string,
  variables: OpVars,
): Promise<unknown> => {
  await settle(5);
  const resolve = ops[op];
  if (!resolve) {
    throw new Error(`Unknown data-edge op: ${op}`);
  }
  return resolve(variables);
};
