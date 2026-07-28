import type { GetServerSideProps } from "next/types";
import Head from "next/head";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { applyCachePolicy } from "@atlas/edge-policy/policy";
import { isBlank } from "@atlas/env/runtime";
import { CREDENTIAL_SCOPE, PRODUCT } from "@atlas/fixed/product";
import type { AssetCard } from "@atlas/graph-handle/ops";
import { prefetchStore } from "@atlas/graph-handle/prefetch-state";
import {
  graphHandleOptionsFromEnv,
  openServerGraphHandle,
} from "@atlas/graph-handle/server";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";

type LookupResults = {
  term: string;
  total: number;
  matches: AssetCard[];
};

export type LookupProps = PageLiftedProps & {
  results: LookupResults;
};

export type LookupComponentProps = Omit<
  LookupProps,
  "lifted" | "graphSnapshot" | "edgeProbeData"
>;

const LookupPage = ({ results }: LookupComponentProps) => (
  <>
    <Head>
      <title>{`Lookup: ${results.term} | atlas`}</title>
    </Head>
    <section data-testid="lookup-results" data-term={results.term}>
      <h1>Matches for “{results.term}”</h1>
      <ol>
        {results.matches.map((asset) => (
          <li key={asset.assetId}>{asset.title}</li>
        ))}
      </ol>
    </section>
  </>
);

const pageData: GetServerSideProps<LookupProps> = async (context) => {
  // Lookup results are surrogate-cached for 4 hours, browsers for 10 min.
  applyCachePolicy({
    res: context.res,
    surrogateSeconds: 14400,
    browserSeconds: 600,
  });
  if (
    isBlank(context.query.term) ||
    (!isBlank(context.query.page) &&
      Number.isNaN(Number.parseInt(context.query.page as string, 10)))
  ) {
    return Promise.resolve({ notFound: true as const });
  }

  const prefetch = prefetchStore({ browser: false });
  const handle = openServerGraphHandle({
    ...graphHandleOptionsFromEnv(process.env, {
      credentialScope: CREDENTIAL_SCOPE,
      handleName: `${PRODUCT}-lookup`,
    }),
    prefetch,
  });

  const results = await handle.run<LookupResults>("lookupAssets", {
    term: String(context.query.term),
  });

  return {
    props: {
      results,
      graphSnapshot: prefetch.snapshot(),
      lifted: {
        viewKind: ViewKind.LOOKUP,
        renderedAtMs: Date.now(),
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default LookupPage;
