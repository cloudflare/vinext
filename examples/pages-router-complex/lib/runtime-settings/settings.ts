/**
 * Environment-derived runtime settings, split into a full server-side view
 * and a public subset that the app shell's getInitialProps serialises into
 * props (and ProviderShell re-exposes through context).
 *
 * Secrets are resolved under a per-product credential scope (`ATLAS_...`) so
 * shared modules can be pointed at different credentials per consuming
 * product — the same pattern `credentialScope` follows throughout this app.
 */

export type DataEdgeSettings = {
  url: string;
  token: string;
};

export type PublicSettings = {
  dataEdge: DataEdgeSettings;
  tagsScriptUrl?: string;
  trialsSnippetId?: string;
  rumProbeUrl?: string;
  engage?: {
    appId?: string;
    apiKey?: string;
  };
};

export type ServerSettings = PublicSettings & {
  relayUpstreamUrl: string;
  purgeBearer?: string;
};

const env = (key: string): string | undefined => process.env[key];

export const scopedSecret = (
  credentialScope: string,
  name: string,
): string | undefined => env(`${credentialScope.toUpperCase()}_${name}`);

export const readServerSettings = (): ServerSettings => ({
  dataEdge: {
    url: env("ATLAS_DATA_EDGE_URL") ?? "/api/graph",
    token: env("ATLAS_DATA_EDGE_TOKEN") ?? "dev-loopback-token",
  },
  tagsScriptUrl: env("ATLAS_TAGS_SCRIPT_URL"),
  trialsSnippetId: env("ATLAS_TRIALS_SNIPPET_ID"),
  rumProbeUrl: env("ATLAS_RUM_PROBE_URL"),
  engage: {
    appId: env("ATLAS_ENGAGE_APP_ID"),
    apiKey: env("ATLAS_ENGAGE_API_KEY"),
  },
  relayUpstreamUrl: env("ATLAS_RELAY_UPSTREAM_URL") ?? "",
  purgeBearer: env("ATLAS_PURGE_BEARER"),
});

export const readPublicSettings = (): PublicSettings => {
  const { relayUpstreamUrl: _r, purgeBearer: _p, ...publicSettings } =
    readServerSettings();
  return publicSettings;
};

/**
 * Public settings narrowed to what data-edge-backed pages need. Kept as a
 * dedicated accessor because the architecture historically distinguished two
 * data-layer flavours; the split survives as this call site used by the app
 * shell's getInitialProps.
 */
export const readPublicSettingsForData = (): PublicSettings =>
  readPublicSettings();
