import type { NextI18nConfig } from "../config/next-config.js";
import { normalizeDomainHostname } from "../utils/domain-locale.js";
import { VINEXT_REVALIDATE_HOST_HEADER } from "./headers.js";
import { isOnDemandRevalidateRequest, PRERENDER_REVALIDATE_HEADER } from "./isr-cache.js";

/**
 * Read the logical request hostname carried by a server-pinned revalidation
 * loopback. The side channel is accepted only as part of the authenticated
 * revalidation protocol and only for an exact configured i18n domain.
 */
export function readTrustedRevalidationHostname(
  headers: Headers,
  i18nConfig: NextI18nConfig | null | undefined,
  authorizeRevalidation: (headerValue: string | null) => boolean = isOnDemandRevalidateRequest,
): string | null {
  if (
    !i18nConfig?.domains?.length ||
    !authorizeRevalidation(headers.get(PRERENDER_REVALIDATE_HEADER))
  ) {
    return null;
  }

  const rawHostname = headers.get(VINEXT_REVALIDATE_HOST_HEADER);
  if (!rawHostname) return null;

  const hostname = rawHostname.trim().toLowerCase();
  // The sender transports URL.hostname, never a Host value with a port,
  // comma-list, or surrounding syntax. Reject rather than normalize those
  // shapes so acceptance remains an exact configured-domain comparison.
  if (normalizeDomainHostname(hostname) !== hostname) return null;

  return (
    i18nConfig.domains
      .find((item) => normalizeDomainHostname(item.domain) === hostname)
      ?.domain.toLowerCase() ?? null
  );
}
