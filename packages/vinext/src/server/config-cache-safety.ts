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
 * A response cached by a request that does not satisfy `has`/`missing` would
 * bypass the rule for a later request that does. Unconditional headers and
 * rewrites are deterministic for the public source URL: CDN keys remain
 * source-path keyed while the Worker resolves the same rewrite destination on
 * a miss, matching Next.js's rewritten-path Full Route Cache behavior. Config
 * redirects still return before route admission and remain conservative here.
 */
export function configRoutesCanVaryResponse(options: RequestVaryingConfigRoutes): boolean {
  const conditionalRules = [
    ...options.rewrites.beforeFiles,
    ...options.rewrites.afterFiles,
    ...options.rewrites.fallback,
    ...options.headers,
  ].filter((rule) => (rule.has?.length ?? 0) > 0 || (rule.missing?.length ?? 0) > 0);
  return [...options.redirects, ...conditionalRules].some((rule) =>
    matchesRewriteSource(options.pathname, rule, options.basePathState),
  );
}
