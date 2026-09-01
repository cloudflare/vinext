export function formatDeployHelp(): string {
  return `
  vinext-cloudflare deploy - Deploy to Cloudflare Workers

  Usage: vinext-cloudflare deploy [options]

  One-command deployment to Cloudflare Workers. Automatically:
    - Detects App Router or Pages Router
    - Validates setup from vinext init --platform=cloudflare
    - Builds the project with Vite
    - Deploys via wrangler

  Options:
    --preview                Deploy to preview environment (same as --env preview)
    --env <name>             Deploy using wrangler env.<name>
    --name <name>            Custom Worker name (default: from package.json)
    --config <path>          Wrangler config path (default: wrangler.jsonc/json/toml)
    --skip-build             Skip the build step (use existing dist/)
    --dry-run                Validate setup without building or deploying
    --verbose                Print raw output from internal Wrangler commands
    --prerender-all          Pre-render discovered routes after building (future
                             releases will auto-populate the remote cache)
    --prerender-concurrency <count>
                             Maximum number of routes to pre-render in parallel
    --experimental-warm-cdn-cache
                             Upload a Worker version, warm build-discovered paths
                             through the production URL, then promote it (experimental)
    --warm-cdn-target <origin>
                             HTTPS origin to use for discovery, probing, and warming
                             (overrides URLs inferred from Wrangler output)
    --warm-cdn-concurrency <count>
                             Maximum number of CDN warmup requests in parallel (default: 25)
    --warm-cdn-timeout <ms>  Per-request CDN warmup timeout (default: 10000)
    --warm-cdn-retries <n>   Retries per failed CDN warmup request (default: 1;
                             staged-version propagation default: 60)
    --warm-cdn-discovery-timeout <ms>
                             Total staged path-discovery deadline (default: 120000)
    --warm-cdn-discovery-retries <n>
                             Optional staged path-discovery retry limit
                             (default: derived from the discovery deadline)
    --warm-cdn-probe-timeout <ms>
                             Abort when cacheability probing makes no progress for
                             this duration (default: 120000)
    --warm-cdn-probe-retries <n>
                             Cacheability-probe retries (default: 2)
    --warm-cdn-certify      With --experimental-warm-cdn-cache, re-request warmed
                             entries using headers only and require every planned
                             entry to be reusable before promotion
    --warm-cdn-readiness-timeout <ms>
                             Explicit total staged-readiness deadline (default:
                             120000)
    --warm-cdn-readiness-retries <n>
                             Staged-readiness retries (default: 60)
    --warm-cdn-readiness-probes <count>
                             Consecutive successful staged-readiness probes
                             required before warming (default: 6)
    --warm-cdn-readiness-probe-delay <ms>
                             Delay between staged-readiness probes (default: 1000)
    --dangerously-promote-on-cdn-warm-error
                             Promote even when ordinary staged warmup cannot be
                             verified (never bypasses --warm-cdn-certify)
    --warm-cdn-no-promote    Leave the warmed Worker version staged at 0% traffic;
                             production triggers are still applied before warming
    --warm-cdn-promotion-delay <ms>
                             Delay before promotion after warmup (default: 15000)
    --warm-cdn-include-fallbacks
                             Also warm PPR fallback-shell placeholder paths
    -h, --help               Show this help

  Experimental:
    --experimental-tpr               Enable Traffic-aware Pre-Rendering
    --tpr-coverage <pct>             Traffic coverage target, 0-100 (default: 90)
    --tpr-limit <count>              Hard cap on pages to pre-render (default: 1000)
    --tpr-window <hours>             Analytics lookback window in hours (default: 24)

  TPR (Traffic-aware Pre-Rendering) uses Cloudflare zone analytics to determine
  which pages get the most traffic and pre-renders them into KV cache during
  deploy. This feature is experimental and must be explicitly enabled. Requires
  a custom domain (zone analytics are unavailable on *.workers.dev) and the
  CLOUDFLARE_API_TOKEN environment variable with Zone.Analytics read permission.

  Workers Cache automatically uses tiered caching. Warmed entries can therefore
  be reused outside the data center reached by the warmup request after cache
  propagation, but the deploy does not wait for every edge location to fill.

  Examples:
    npx @vinext/cloudflare deploy                                      Build and deploy to production
    vpx @vinext/cloudflare deploy                                      Build and deploy with Vite+
    vp exec vinext-cloudflare deploy                                   Run the locally installed Vite+ bin
    vinext-cloudflare deploy --preview                                 Deploy to a preview URL
    vinext-cloudflare deploy --env staging                             Deploy using wrangler env.staging
    vinext-cloudflare deploy --config dist/server/wrangler.json        Deploy using a generated Wrangler config
    vinext-cloudflare deploy --dry-run                                 Validate setup without building or deploying
    vinext-cloudflare deploy --name my-app                             Deploy with a custom Worker name
    vinext-cloudflare deploy --experimental-warm-cdn-cache              Warm build-discovered paths during version deploy (experimental)
    vinext-cloudflare deploy --experimental-warm-cdn-cache --warm-cdn-target https://example.com
                                                                          Warm an explicit production origin
    vinext-cloudflare deploy --experimental-tpr                        Enable TPR during deploy
    vinext-cloudflare deploy --experimental-tpr --tpr-coverage 95      Cover 95% of traffic
    vinext-cloudflare deploy --experimental-tpr --tpr-limit 500        Cap at 500 pages
`;
}

export function printDeployHelp(): void {
  console.log(formatDeployHelp());
}
