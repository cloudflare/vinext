import type { NextI18nConfig } from "../config/next-config.js";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { detectDomainLocale, normalizeDomainHostname } from "../utils/domain-locale.js";
import { VINEXT_CACHE_IDENTITY_ORIGIN } from "./multi-stage.js";

/** Whether the configured adapter keys shared dispatches by a core cache identity. */
export function adapterUsesSharedCacheIdentity(): boolean {
  const adapter = getCdnCacheAdapter();
  // The identity is host-free, and query-free for App pages, so it is safe
  // only behind completed-response admission, which refuses dynamic renders
  // and App pages without a negative searchParams proof.
  return (
    adapter.requiresCompletedResponseAdmission === true &&
    adapter.responseStageCacheIdentity === "query-free"
  );
}

/**
 * The origin a shared Pages page identity names. A static Pages render reads
 * the host only to select a configured i18n domain, so the identity keeps that
 * domain, as vinext's Pages ISR key does, and every other host shares one entry.
 */
export function pagesCacheIdentityOrigin(
  requestUrl: string,
  i18nConfig: NextI18nConfig | null | undefined,
): string {
  const domainLocale = detectDomainLocale(i18nConfig?.domains, new URL(requestUrl).hostname);
  if (!domainLocale) return VINEXT_CACHE_IDENTITY_ORIGIN;
  return `${domainLocale.http ? "http" : "https"}://${normalizeDomainHostname(domainLocale.domain)}`;
}
