type GeneratedDataRegistration = {
  handler: unknown;
  kind: "generated";
};

type GeneratedCdnRegistration = {
  adapter: unknown;
  kind: "generated";
};

const DATA_HANDLER_KEY = Symbol.for("vinext.cacheHandler");
const DATA_REGISTRATION_KEY = Symbol.for("vinext.configuredCacheHandler");
const CDN_ADAPTER_KEY = Symbol.for("vinext.cdnCacheAdapter");
const CDN_REGISTRATION_KEY = Symbol.for("vinext.configuredCdnCacheAdapter");
const state = globalThis as unknown as Record<PropertyKey, unknown>;

/** @internal Drop a stale generated handler without loading the cache runtime. */
export function deactivateGeneratedDataCacheHandler(): void {
  const registration = state[DATA_REGISTRATION_KEY] as GeneratedDataRegistration | undefined;
  if (registration?.kind !== "generated") return;

  if (state[DATA_HANDLER_KEY] === registration.handler) {
    delete state[DATA_HANDLER_KEY];
  }
  delete state[DATA_REGISTRATION_KEY];
}

/** @internal Drop a stale generated adapter without loading the CDN cache runtime. */
export function deactivateGeneratedCdnCacheAdapter(): void {
  const registration = state[CDN_REGISTRATION_KEY] as GeneratedCdnRegistration | undefined;
  if (registration?.kind !== "generated") return;

  if (state[CDN_ADAPTER_KEY] === registration.adapter) {
    delete state[CDN_ADAPTER_KEY];
  }
  delete state[CDN_REGISTRATION_KEY];
}
