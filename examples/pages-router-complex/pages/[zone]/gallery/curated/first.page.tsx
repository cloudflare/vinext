import type { GetServerSideProps } from "next";
import Head from "next/head";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";

/** Static sibling that must beat the `gallery/[...facets]` catch-all. */
export type CuratedFirstProps = PageLiftedProps & { rank: number };

const CuratedFirst = ({ rank }: CuratedFirstProps) => (
  <>
    <Head>
      <title>Curated wall one | atlas</title>
    </Head>
    <section data-testid="curated-wall" data-rank={rank}>
      <h1>Curated wall one</h1>
    </section>
  </>
);

const pageData: GetServerSideProps<CuratedFirstProps> = async () => ({
  props: {
    rank: 1,
    lifted: { viewKind: ViewKind.GALLERY, renderedAtMs: Date.now() },
  },
});

export const getServerSideProps = meterServerProps(pageData);

export default CuratedFirst;
