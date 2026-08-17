import type { GetServerSideProps } from "next";
import Head from "next/head";
import Link from "next/link";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { applyCachePolicy } from "@atlas/edge-policy/policy";
import { CREDENTIAL_SCOPE, PRODUCT } from "@atlas/fixed/product";
import type { AssetCard } from "@atlas/graph-handle/ops";
import { useGraphOp } from "@atlas/graph-handle/react";
import { prefetchStore } from "@atlas/graph-handle/prefetch-state";
import {
  graphHandleOptionsFromEnv,
  openServerGraphHandle,
} from "@atlas/graph-handle/server";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";
import { zoneFromRouteQuery } from "@atlas/zones/zone";

import { readFrontDoorTtl } from "../../helpers/front-door-ttl";

type FrontDoorFeed = {
  heading: string;
  modules: string[];
  featured: AssetCard[];
};

export type FrontDoorProps = PageLiftedProps & {
  zoneSlug: string;
};

const FrontDoor = ({ zoneSlug }: FrontDoorProps) => {
  // Reads from the graph snapshot seeded during SSR — no client refetch.
  const feed = useGraphOp<FrontDoorFeed>("frontDoorFeed", { zoneId: zoneSlug });

  return (
    <>
      <Head>
        <title>atlas — front door</title>
        <meta name="description" content="a complex pages-router fixture" />
      </Head>
      <h1 data-testid="front-heading" data-from-snapshot={feed.fromSnapshot}>
        {feed.data?.heading ?? "…"}
      </h1>
      <ul data-testid="front-featured">
        {(feed.data?.featured ?? []).map((asset) => (
          <li key={asset.assetId}>
            <Link href={`/${asset.collection}/item/${asset.assetId}`} prefetch={false}>
              {asset.title}
            </Link>
          </li>
        ))}
      </ul>
      <p>
        <Link href="/gallery/skies" data-testid="front-to-gallery">
          Browse the skies wall
        </Link>
      </p>
      <p>
        <Link href="/diagnostics" data-testid="front-to-diagnostics">
          Diagnostics
        </Link>
      </p>
    </>
  );
};

const pageData: GetServerSideProps<FrontDoorProps> = async (context) => {
  const { frontDoorTtl } = await readFrontDoorTtl();
  applyCachePolicy({
    res: context.res,
    surrogateSeconds: frontDoorTtl,
    browserSeconds: 300,
  });

  const zone = zoneFromRouteQuery(context.query);
  const prefetch = prefetchStore({ browser: false });
  const handle = openServerGraphHandle({
    ...graphHandleOptionsFromEnv(process.env, {
      credentialScope: CREDENTIAL_SCOPE,
      handleName: `${PRODUCT}-front`,
    }),
    prefetch,
  });

  await handle.run<FrontDoorFeed>("frontDoorFeed", { zoneId: zone.slug });

  return {
    props: {
      zoneSlug: zone.slug,
      graphSnapshot: prefetch.snapshot(),
      lifted: {
        viewKind: ViewKind.FRONT,
        renderedAtMs: Date.now(),
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default FrontDoor;
