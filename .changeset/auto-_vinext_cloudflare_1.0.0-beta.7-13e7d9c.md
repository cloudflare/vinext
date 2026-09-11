---
"@vinext/cloudflare": minor
"vinext": minor
---

- perf(cloudflare): cut KV data cache round trips from 3 to 2 per tagged hit (#3187)
- fix(cloudflare): restore bounded probe scheduling (#3171)
- fix(cloudflare): reduce staged CDN probe work (#3168)
- fix(cache): preserve staged cache invalidation parity (#3158)
- fix(cloudflare): prewarm routed response stages (#3153)
- feat(cloudflare): isolate cached response entrypoint (#3152)
- fix(build): preserve staged prerender routing (#3151)
- feat(cloudflare): summarize CDN warmup by route (#3163)
- fix(cloudflare): wait for per-route version propagation (#3164)
- fix(isr): ignore interception context on HTML renders (#2915)
- fix(app-router): dedupe next/dynamic module preloads (#3186)
- feat(build): support independently deployed worker stages (#3155)
- feat(build): select adapter-owned worker stages (#3150)
- feat(build): define adapter-owned worker stages (#3142)
- fix(cache): resolve CDN admission from matched route kind (#3160)
