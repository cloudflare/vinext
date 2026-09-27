export function formatDeployHelp(): string {
  return `
  vinext-cloudflare deploy - Deploy to Cloudflare Workers

  Usage: vinext-cloudflare deploy [options]

  One-command deployment to Cloudflare Workers. Automatically:
    - Detects App Router or Pages Router
    - Validates setup from vinext init --platform=cloudflare
    - Builds the project with Vite
    - Deploys with cf for typed Cloudflare config projects, or Wrangler otherwise

  Options:
    --preview                Deploy to preview environment (same as --env preview)
    --env <name>             Cloudflare mode for typed config; Wrangler environment otherwise
    --name <name>            Custom Worker name for Wrangler config projects
    --config <path>          Wrangler config path (default: wrangler.jsonc/json/toml)
    --skip-build             Skip the build step (use existing dist/)
    --dry-run                Validate setup without building or deploying
    --verbose                Print raw output from internal Cloudflare CLI commands
    --no-promote             Do not promote the uploaded Worker version to 100%
                             traffic
    --prerender-all          Pre-render discovered routes after building (future
                             releases will auto-populate the remote cache)
    --prerender-concurrency <count>
                             Maximum number of routes to pre-render in parallel
    --warm-cache             Upload a Worker version, warm build-discovered paths
                             through the production URL, then promote it
    --warm-cache-target <origin>
                             HTTPS origin to use for discovery, probing, and warming
                             (overrides URLs inferred from Wrangler output)
                             Also supported with traffic-aware warming
    --warm-cache-concurrency <count>
                             Maximum number of CDN warmup requests in parallel (default: 25)
    --warm-cache-timeout <ms>  Per-request CDN warmup timeout (default: 10000)
    --warm-cache-retries <n>   Retries per failed CDN warmup request (default: 1;
                             staged-version propagation default: 60)
    --warm-cache-discovery-timeout <ms>
                             Total staged path-discovery deadline (default: 120000)
    --warm-cache-discovery-retries <n>
                             Optional staged path-discovery retry limit
                             (default: derived from the discovery deadline)
    --warm-cache-probe-timeout <ms>
                             Abort when cacheability probing makes no progress for
                             this duration (default: 120000)
    --warm-cache-probe-retries <n>
                             Cacheability-probe retries (default: 2)
    --warm-cache-certify      With either warming mode, re-request warmed
                             entries using headers only and require reusable hits.
                             Traffic-aware warming requires every selected entry
                             to be reusable before promotion
    --warm-cache-readiness-timeout <ms>
                             Explicit total staged-readiness deadline (default:
                             120000)
    --warm-cache-readiness-retries <n>
                             Staged-readiness retries (default: 60)
    --warm-cache-readiness-probes <count>
                             Consecutive successful staged-readiness probes
                             required before warming (default: 6)
    --warm-cache-readiness-probe-delay <ms>
                             Delay between staged-readiness probes (default: 1000)
    --dangerously-promote-on-warm-cache-error
                             Promote even when ordinary staged warmup cannot be
                             verified (never bypasses --warm-cache-certify)
    --warm-cache-promotion-delay <ms>
                             Delay before promotion after warmup (default: 15000)
    --warm-cache-include-fallbacks
                             Also warm PPR fallback-shell placeholder paths
    -h, --help               Show this help

  Traffic-aware warming:
    --traffic-aware-warm-cache       Select cache warming routes from traffic
    --traffic-aware-coverage <pct>   Traffic coverage target, 0-100 (default: 90)
    --traffic-aware-limit <count>    Hard cap on selected routes (default: 1000)
    --traffic-aware-window <hours>   Analytics lookback window in hours (default: 24)

  Traffic-aware warming uses Cloudflare zone analytics to select the
  highest-traffic routes, then feeds those routes into the same staged CDN
  pre-warming flow used by --warm-cache. It requires a custom
  domain and a CLOUDFLARE_API_TOKEN with Zone > Analytics > Read and
  Zone > Zone > Read permissions for that zone.
  Use --warm-cache-target <origin> to provide the production HTTPS origin
  manually for traffic-aware analytics selection, discovery, probing, and warming.

  Workers Cache automatically uses tiered caching. Warmed entries can therefore
  be reused outside the data center reached by the warmup request after cache
  propagation, but the deploy does not wait for every edge location to fill.

  Examples:
    npx @vinext/cloudflare deploy                                      Build and deploy to production
    vpx @vinext/cloudflare deploy                                      Build and deploy with Vite+
    vp exec vinext-cloudflare deploy                                   Run the locally installed Vite+ bin
    vinext-cloudflare deploy --preview                                 Deploy to a preview URL
    vinext-cloudflare deploy --env staging                             Deploy using Cloudflare mode/environment staging
    vinext-cloudflare deploy --config dist/server/wrangler.json        Deploy using a generated Wrangler config
    vinext-cloudflare deploy --dry-run                                 Validate setup without building or deploying
    vinext-cloudflare deploy --name my-app                             Deploy with a custom Worker name
    vinext-cloudflare deploy --no-promote                              Upload a version without changing deployment traffic
    vinext-cloudflare deploy --warm-cache                               Warm build-discovered paths during version deploy
    vinext-cloudflare deploy --warm-cache --warm-cache-target https://example.com
                                                                          Warm an explicit production origin
    vinext-cloudflare deploy --traffic-aware-warm-cache
                                                                          Enable traffic-aware warming
    vinext-cloudflare deploy --traffic-aware-warm-cache --traffic-aware-coverage 95
                                                                          Cover 95% of traffic
    vinext-cloudflare deploy --traffic-aware-warm-cache --traffic-aware-limit 500
                                                                          Cap at 500 routes
    vinext-cloudflare deploy --traffic-aware-warm-cache --warm-cache-target https://example.com
                                                                          Select and warm traffic routes for an explicit origin
`;
}

export function printDeployHelp(): void {
  console.log(formatDeployHelp());
}
