import type { HasCondition, NextRewrite, ResolvedNextConfig } from "../config/next-config.js";
import { isExternalUrl } from "../utils/external-url.js";

type ClientHasCondition = Omit<HasCondition, "type"> & {
  type: "host" | "query";
};

type ClientRewriteFields = Pick<NextRewrite, "basePath" | "locale" | "source"> & {
  has?: ClientHasCondition[];
};

/**
 * Rewrite data that is safe to publish in a browser bundle.
 *
 * Rules that require server-only data deliberately omit both the destination
 * and the data that made server evaluation necessary. The client can still
 * use browser-authoritative conditions as a prefilter before handing the
 * navigation to the server.
 */
export type ClientRewrite =
  | (ClientRewriteFields & {
      destination: string;
      requiresServerEvaluation?: never;
    })
  | (ClientRewriteFields & {
      destination?: never;
      requiresServerEvaluation: true;
    });

export type ClientRewrites = {
  afterFiles: ClientRewrite[];
  beforeFiles: ClientRewrite[];
  fallback: ClientRewrite[];
};

function isClientHasCondition(condition: HasCondition): condition is ClientHasCondition {
  switch (condition.type) {
    case "host":
    case "query":
      return true;
    case "cookie":
    case "header":
      // Headers may be added or changed by an intermediary, and HttpOnly
      // cookies are intentionally unavailable to browser JavaScript.
      return false;
    default:
      // Runtime config is an external boundary. Keep unknown future condition
      // types server-owned even before the public TypeScript type learns them.
      return false;
  }
}

function toClientRewrite(rewrite: NextRewrite): ClientRewrite {
  const clientHas = rewrite.has?.filter(isClientHasCondition);
  const hasServerOnlyCondition =
    rewrite.has?.some((condition) => !isClientHasCondition(condition)) ?? false;
  const common = {
    source: rewrite.source,
    has: clientHas?.length ? clientHas : undefined,
    locale: rewrite.locale,
    basePath: rewrite.basePath,
  };

  if (
    isExternalUrl(rewrite.destination) ||
    (rewrite.missing?.length ?? 0) > 0 ||
    hasServerOnlyCondition
  ) {
    return {
      ...common,
      requiresServerEvaluation: true,
    };
  }

  return {
    source: rewrite.source,
    destination: rewrite.destination,
    has: common.has,
    locale: rewrite.locale,
    basePath: rewrite.basePath,
  };
}

export function toClientRewrites(rewrites: ResolvedNextConfig["rewrites"]): ClientRewrites {
  return {
    beforeFiles: rewrites.beforeFiles.map(toClientRewrite),
    afterFiles: rewrites.afterFiles.map(toClientRewrite),
    fallback: rewrites.fallback.map(toClientRewrite),
  };
}
