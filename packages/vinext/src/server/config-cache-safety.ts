import type { NextHeader, NextRedirect, NextRewrite } from "../config/next-config.js";
import { matchesRewriteSource, type BasePathMatchState } from "../config/config-matchers.js";

type RequestVaryingConfigRoutes = {
  basePathState: BasePathMatchState;
  headers: readonly NextHeader[];
  pathname: string;
  redirects: readonly NextRedirect[];
  rewrites: {
    afterFiles: readonly NextRewrite[];
    beforeFiles: readonly NextRewrite[];
    fallback: readonly NextRewrite[];
  };
};

/**
 * Whether a next.config route can change this pathname's response identity.
 *
 * Conditions are intentionally ignored: a response cached by a request that
 * does not satisfy `has`/`missing` would bypass the rule for a later request
 * that does. Unconditional header rules are safe because every request gets
 * the same values; redirects and rewrites always change route identity.
 */
export function configRoutesCanVaryResponse(options: RequestVaryingConfigRoutes): boolean {
  const conditionalHeaders = options.headers.filter(
    (rule) => (rule.has?.length ?? 0) > 0 || (rule.missing?.length ?? 0) > 0,
  );
  const rules = [
    ...options.rewrites.beforeFiles,
    ...options.rewrites.afterFiles,
    ...options.rewrites.fallback,
    ...options.redirects,
    ...conditionalHeaders,
  ];
  return rules.some((rule) => matchesRewriteSource(options.pathname, rule, options.basePathState));
}
