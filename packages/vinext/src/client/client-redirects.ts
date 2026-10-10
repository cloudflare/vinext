import type { NextRedirect, ResolvedNextConfig } from "../config/next-config.js";
import { isClientHasCondition, type ClientHasCondition } from "./client-rewrites.js";

type ClientRedirectFields = Pick<NextRedirect, "basePath" | "locale" | "source"> & {
  has?: ClientHasCondition[];
  missing?: ClientHasCondition[];
};

/**
 * Redirect data that is safe to publish in a browser bundle.
 *
 * Next.js keeps redirects in the server routes manifest only. Vinext resolves
 * browser-authoritative redirects during Pages Router navigation, but rules
 * with header or cookie conditions are server-owned: their condition values
 * can be private, so the rule keeps only its source and client-safe
 * conditions to preserve first-match ordering, and drops its destination.
 */
export type ClientRedirect =
  | (ClientRedirectFields & {
      destination: string;
      permanent: boolean;
      requiresServerEvaluation?: never;
    })
  | (ClientRedirectFields & {
      destination?: never;
      permanent?: never;
      requiresServerEvaluation: true;
    });

function toClientRedirect(redirect: NextRedirect): ClientRedirect {
  const hasServerOnlyCondition =
    (redirect.has?.some((condition) => !isClientHasCondition(condition)) ?? false) ||
    (redirect.missing?.some((condition) => !isClientHasCondition(condition)) ?? false);
  const clientHas = redirect.has?.filter(isClientHasCondition);
  const clientMissing = redirect.missing?.filter(isClientHasCondition);
  const common = {
    source: redirect.source,
    has: clientHas?.length ? clientHas : undefined,
    missing: clientMissing?.length ? clientMissing : undefined,
    locale: redirect.locale,
    basePath: redirect.basePath,
  };

  if (hasServerOnlyCondition) {
    return { ...common, requiresServerEvaluation: true };
  }

  return { ...common, destination: redirect.destination, permanent: redirect.permanent };
}

export function toClientRedirects(redirects: ResolvedNextConfig["redirects"]): ClientRedirect[] {
  return redirects.map(toClientRedirect);
}
