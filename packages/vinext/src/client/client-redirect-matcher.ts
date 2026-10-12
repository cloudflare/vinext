import {
  matchRedirect,
  type BasePathMatchState,
  type RedirectMatch,
  type RequestContext,
} from "../config/config-matchers.js";
import type { NextRedirect } from "../config/next-config.js";
import type { ClientRedirect } from "./client-redirects.js";

// Keyed by the published rule so matchRedirect's per-array index stays cached
// across navigations.
const matcherRules = new WeakMap<ClientRedirect, NextRedirect[]>();

function getMatcherRule(redirect: ClientRedirect): NextRedirect[] {
  let rule = matcherRules.get(redirect);
  if (!rule) {
    rule = [
      {
        source: redirect.source,
        // Server-evaluated rules use a harmless local destination only to
        // determine whether their client-safe source/has fields match.
        destination: redirect.destination ?? "/",
        permanent: redirect.permanent ?? false,
        has: redirect.has,
        missing: redirect.missing,
        locale: redirect.locale,
        basePath: redirect.basePath,
      },
    ];
    matcherRules.set(redirect, rule);
  }
  return rule;
}

/**
 * Resolve the first matching client-safe redirect. A matching server-owned
 * rule stops client evaluation and returns null so a later client-safe rule
 * cannot take its place. The navigation then continues as it does in Next.js,
 * which never resolves config redirects in the browser: a document request (or
 * a data request that falls back to one) reaches the server rule, while a page
 * without data fetching renders without it.
 */
export function matchClientRedirect(
  pathname: string,
  redirects: ClientRedirect[],
  context: RequestContext,
  basePathState: BasePathMatchState,
): RedirectMatch | null {
  for (const redirect of redirects) {
    if (redirect.localeFallback) continue;
    const match = matchRedirect(pathname, getMatcherRule(redirect), context, basePathState);
    if (match === null) continue;
    return redirect.requiresServerEvaluation ? null : match;
  }
  return null;
}
