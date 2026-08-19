import type { NextHeader, NextRedirect, NextRewrite } from "../config/next-config.js";

export type PrewarmSourceObservation = {
  conditionalConfigPathMatched: boolean;
  conditionalMiddlewarePathMatched: boolean;
  middlewareEvaluationComplete: boolean;
  middlewareMatched: boolean;
};

export function createPrewarmSourceObservation(hasMiddleware: boolean): PrewarmSourceObservation {
  return {
    conditionalConfigPathMatched: false,
    conditionalMiddlewarePathMatched: false,
    middlewareEvaluationComplete: !hasMiddleware,
    middlewareMatched: false,
  };
}

export function observePrewarmMiddlewareMatcher(
  observation: PrewarmSourceObservation,
  matcher: { conditionalPathMatched: boolean; matched: boolean },
): void {
  observation.middlewareEvaluationComplete = true;
  observation.middlewareMatched ||= matcher.matched;
  observation.conditionalMiddlewarePathMatched ||= matcher.conditionalPathMatched;
}

export function isPrewarmSourceIndependent(observation: PrewarmSourceObservation): boolean {
  return (
    observation.middlewareEvaluationComplete &&
    !observation.middlewareMatched &&
    !observation.conditionalMiddlewarePathMatched &&
    !observation.conditionalConfigPathMatched
  );
}

/**
 * Whether a config rule can produce a different response for the same shared
 * prewarm URL. Query conditions remain separated by the URL cache key, except
 * for `_rsc`: response-Vary mode deliberately collapses its bare and hashed
 * transport forms. Canonical RSC requests also fix `RSC` and `Accept` to one
 * framework-owned shape, while document requests make no such guarantee.
 */
export function configRuleMayVaryAcrossPrewarmRequests(
  rule: NextHeader | NextRedirect | NextRewrite,
  requestKind: "document" | "rsc",
): boolean {
  return [...(rule.has ?? []), ...(rule.missing ?? [])].some((condition) => {
    if (condition.type === "cookie" || condition.type === "host") return true;
    if (condition.type === "header") {
      if (requestKind === "document") return true;
      const key = condition.key.toLowerCase();
      return key !== "rsc" && key !== "accept";
    }
    return requestKind === "rsc" && condition.key === "_rsc";
  });
}
