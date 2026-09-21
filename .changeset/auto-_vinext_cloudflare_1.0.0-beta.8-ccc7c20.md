---
"@cloudflare/workers-response-store": minor
"@vinext/cloudflare": major
"vinext": major
---

- feat(response-store): read response metadata from R2 (#3339)
- fix(cache): bypass shared lookup for force-dynamic routes (#3346)
- refactor(cloudflare): route traffic-aware warming through standard prewarming (#3338)
- feat: feat(tracing): add Next.js-compatible OpenTelemetry instrumentation with Sentry and Cloudflare Workers tracing support (#3261)
- fix(cloudflare): prewarm KV through deployed Workers (#3324)
- feat(cloudflare): allow version uploads without promotion (#3337)
- fix(response-store): stabilize cached variant selection (#3308)
- feat(response-store): support for sharded durable objects (#3301)
- fix(config): prioritize explicit aliases over tsconfig paths (#3347)
- fix(build): defer user imports until request initialization (#3345)
- feat: feat(tracing): emit built-in request, rendering, fetch, metadata, and response spans across the App and Pages Routers (#3296)
- fix(dev): optimize Chakra UI barrel imports (#3317)
- fix(check): ignore build output from other toolchains (#3231)
- fix(build): preserve bundled Nitro service exports (#3312)
- fix(server): align user agent parsing with Next.js (#3202)
- fix(pages): serve dynamic Pages Router routes under the Nitro preset (#3197) (#3204)
- fix(cache): expose response store entrypoints in dev (#3306)
- perf(response-store): coalesce binding metadata misses (#3304)
- fix(response-store): index orphan cleanup lookups (#3303)
