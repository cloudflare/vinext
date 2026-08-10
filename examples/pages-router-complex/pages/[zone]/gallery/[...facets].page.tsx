import type { GetServerSideProps } from "next/types";
import Head from "next/head";
import { useRouter } from "next/router";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { applyCachePolicy } from "@atlas/edge-policy/policy";
import { CREDENTIAL_SCOPE, PRODUCT } from "@atlas/fixed/product";
import { InternalRoutePattern } from "@atlas/fixed/route-patterns";
import type { AssetCard } from "@atlas/graph-handle/ops";
import { useGraphOp } from "@atlas/graph-handle/react";
import { prefetchStore } from "@atlas/graph-handle/prefetch-state";
import {
  graphHandleOptionsFromEnv,
  openServerGraphHandle,
} from "@atlas/graph-handle/server";
import { readGatewayRestSettings } from "@atlas/gateway/settings";
import { tightAssetPolicyArm } from "@atlas/trials/trials";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";
import { zoneFromRouteQuery } from "@atlas/zones/zone";

import { sendTightAssetPolicyHeader } from "../../../helpers/asset-policy";
import {
  isFacetQueryAcceptable,
  isMalformedTrail,
  missForWall,
  redirectForMalformedTrail,
  scrubWallPath,
  wallPathFromQuery,
} from "../../../helpers/facet-guards";

type TopicNode = {
  nodeRef: string;
  name: string;
  assets: AssetCard[];
};

export type GalleryWallProps = PageLiftedProps & {
  wallPath: string;
  startPage: number;
  gatewayRest?: { baseUrl: string; apiKey: string };
};

export type GalleryWallComponentProps = Omit<
  GalleryWallProps,
  "lifted" | "graphSnapshot" | "edgeProbeData"
>;

const SORT_ORDERS = ["featured", "newest", "alpha"] as const;
type SortOrder = (typeof SORT_ORDERS)[number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const orderAssets = (assets: AssetCard[], sort: SortOrder): AssetCard[] => {
  switch (sort) {
    case "alpha":
      return [...assets].sort((a, b) => a.title.localeCompare(b.title));
    case "newest":
      return [...assets].reverse();
    default:
      return assets;
  }
};

const GalleryWall = ({ wallPath, startPage }: GalleryWallComponentProps) => {
  const router = useRouter();
  const leaf = wallPath.split("/").filter(Boolean)[1] ?? "";
  const node = useGraphOp<TopicNode>("nodeByTrail", { trail: leaf });

  const sort = (SORT_ORDERS as readonly string[]).includes(
    String(router.query["sort"]),
  )
    ? (String(router.query["sort"]) as SortOrder)
    : "featured";

  /**
   * Shallow navigation: push the *internal* dynamic-route pattern as
   * `pathname` (params spelled out in `query`), the public URL as `as`, and
   * `shallow: true` so getServerSideProps does not re-run — the wall
   * reorders client-side off `router.query`.
   */
  const onSortChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextSort = event.target.value;

    await sleep(50);
    void router.push(
      {
        pathname: InternalRoutePattern.GALLERY,
        query: {
          zone: router.query["zone"],
          facets: router.query["facets"],
          sort: nextSort,
        },
      },
      `${wallPath}?sort=${nextSort}`,
      { shallow: true },
    );
    event.stopPropagation();
  };

  return (
    <>
      <Head>
        <title>{`Gallery ${wallPath} | atlas`}</title>
      </Head>
      <section
        data-testid="gallery-wall"
        data-wall-path={wallPath}
        data-start-page={startPage}
        data-sort={sort}
        data-from-snapshot={node.fromSnapshot}
      >
        <h1>Wall: {node.data?.name ?? "…"}</h1>
        <label>
          Order
          <select
            data-testid="wall-sort"
            value={sort}
            onChange={(event) => void onSortChange(event)}
          >
            {SORT_ORDERS.map((order) => (
              <option key={order} value={order}>
                {order}
              </option>
            ))}
          </select>
        </label>
        <ol>
          {orderAssets(node.data?.assets ?? [], sort).map((asset) => (
            <li key={asset.assetId}>{asset.title}</li>
          ))}
        </ol>
      </section>
    </>
  );
};

/** Per-wall surrogate TTLs; campaigns shorten specific walls. */
const WALL_TTL_SECONDS: Record<string, number> = {
  "/gallery/skies/clips": 3600,
};
const DEFAULT_WALL_TTL_SECONDS = 10800;

const pageData: GetServerSideProps<GalleryWallProps> = async (context) => {
  const zone = zoneFromRouteQuery(context.query);
  const wallPath = wallPathFromQuery(context.query);
  const facetSegments = wallPath.split("/").filter(Boolean).slice(1);

  applyCachePolicy({
    res: context.res,
    surrogateSeconds: WALL_TTL_SECONDS[wallPath] ?? DEFAULT_WALL_TTL_SECONDS,
    surrogateKey: `wall:${facetSegments[0] ?? "root"}`,
    browserSeconds: 600,
  });

  if (!isFacetQueryAcceptable(context)) {
    // Unacceptable query strings still get a cacheable 404 (10 min).
    applyCachePolicy({
      res: context.res,
      surrogateSeconds: 600,
      browserSeconds: 600,
    });
    return missForWall();
  }

  // Overly deep trails collapse permanently onto their first two facets.
  if (facetSegments.length > 2) {
    applyCachePolicy({
      res: context.res,
      surrogateSeconds: 600,
      browserSeconds: 600,
    });
    return {
      redirect: {
        destination: `/gallery/${facetSegments.slice(0, 2).join("/")}`,
        permanent: true,
      },
    };
  }

  // Known-bad trail shapes bounce to the deduplicated wall.
  if (isMalformedTrail(context.query, wallPath)) {
    applyCachePolicy({
      res: context.res,
      surrogateSeconds: 600,
      browserSeconds: 600,
    });
    return redirectForMalformedTrail(wallPath, context.resolvedUrl, { zone });
  }

  // Character-level scrub with an uncacheable redirect.
  const { isOriginalPathClean, scrubbedPath } = scrubWallPath({
    resolvedUrl: context.resolvedUrl,
    ctx: { zone },
  });

  if (!isOriginalPathClean) {
    applyCachePolicy({
      res: context.res,
      surrogateSeconds: 0,
      browserSeconds: 300,
    });
    return Promise.resolve({
      redirect: {
        destination: scrubbedPath,
        permanent: false,
      },
    });
  }

  const policyArm = await tightAssetPolicyArm({ canonicalPath: wallPath });

  if (policyArm.enabled) {
    sendTightAssetPolicyHeader(context, policyArm.reportOnly);
  }

  const prefetch = prefetchStore({ browser: false });
  const handle = openServerGraphHandle({
    ...graphHandleOptionsFromEnv(process.env, {
      credentialScope: CREDENTIAL_SCOPE,
      handleName: `${PRODUCT}-gallery`,
    }),
    prefetch,
  });

  const node = await handle.run<TopicNode | null>("nodeByTrail", {
    trail: facetSegments[0] ?? "",
  });

  if (!node) {
    applyCachePolicy({
      res: context.res,
      surrogateSeconds: 600,
      browserSeconds: 600,
    });
    return missForWall();
  }

  return {
    props: {
      wallPath,
      startPage: Number.parseInt(String(context.query["page"] ?? "1"), 10),
      gatewayRest: readGatewayRestSettings(),
      graphSnapshot: prefetch.snapshot(),
      lifted: {
        viewKind: ViewKind.GALLERY,
        galleryPath: wallPath,
        renderedAtMs: Date.now(),
        seedTrialAttributes: { wall: wallPath },
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default GalleryWall;
