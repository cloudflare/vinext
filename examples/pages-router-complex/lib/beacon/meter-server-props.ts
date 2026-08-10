import type { ParsedUrlQuery } from "node:querystring";

import type { GetServerSideProps, GetServerSidePropsResult, PreviewData } from "next";

import { bumpRequestTally, looksLikeCrawler } from "./tally";

const outcomeStatus = (
  result: GetServerSidePropsResult<Record<string, unknown>>,
  responseStatusCode: number,
): { code: number } => {
  if ("notFound" in result && result.notFound) {
    return { code: 404 };
  }
  if ("redirect" in result) {
    const redirect = result.redirect;
    if ("statusCode" in redirect) {
      return { code: redirect.statusCode };
    }
    return { code: redirect.permanent ? 308 : 307 };
  }
  return { code: responseStatusCode };
};

const tallyPath = (context: {
  resolvedUrl?: string;
  req: { url?: string };
}): string => context.resolvedUrl ?? context.req.url ?? "unknown";

/**
 * Wraps every page's getServerSideProps: records a request tally keyed by
 * outcome (notFound → 404, redirect → 307/308, throw → 500) and rethrows
 * failures untouched. Every page in this app exports the wrapped function,
 * never the raw one.
 */
export const meterServerProps = <
  Props extends { [key: string]: unknown } = { [key: string]: unknown },
  Params extends ParsedUrlQuery = ParsedUrlQuery,
  Preview extends PreviewData = PreviewData,
>(
  pageDataFn: GetServerSideProps<Props, Params, Preview>,
) => {
  const meteredPageDataFn: GetServerSideProps<Props, Params, Preview> = async (
    context,
  ) => {
    const fromCrawler = looksLikeCrawler(context.req?.headers?.["user-agent"]);
    const path = tallyPath(context);

    try {
      const result = await pageDataFn(context);

      const status = outcomeStatus(result, context.res.statusCode);

      bumpRequestTally({
        path,
        method: "GET",
        fromCrawler,
        statusCode: status.code,
      });

      return result;
    } catch (error) {
      bumpRequestTally({
        path,
        method: "GET",
        fromCrawler,
        statusCode: 500,
      });

      throw error;
    }
  };

  return meteredPageDataFn;
};
