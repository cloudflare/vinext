---
"@cloudflare/workers-response-store": minor
"@vinext/cloudflare": minor
"vinext": patch
---

- fix(cache): protect cache function references (#3385)
- perf(cloudflare): reuse response-stage invocations (#3388)
- perf(cache): overlap Response Store soft-tag lookup (#3373)
- feat(response-store): expose metadata location hints (#3383)
- fix(constants): guard Node feature detection in browser imports (#3394)
- perf(render): batch Flight chunks and optimize render hot paths (#3402)
- fix(navigation): clear pending links on server action redirects (#3393)
- fix(head): serialize adjacent head tags without whitespace nodes (#3391)
- perf(render): batch inline RSC chunks (#3397)
- fix: detect Wrangler with Bun on Windows (#3364)
- fix(cache): isolate divergent App Router route identities (#3357)
- fix(metadata): enforce static params for image routes (#3358)
- fix(dev): initialize App instrumentation in the RSC runner (#3363)
- fix(dev): pre-optimize Pages hydration runtime (#3356)
- fix(pages): preserve production CSS graph order (#3314)
- fix(pages): include resolved CSS aliases in dev manifest (#3355)
- fix(app-router): send anonymous crossOrigin on dynamic preloads and bootstrap hints (#3327)
- perf(response-store): project refresh candidates (#3389)
- perf(response-store): index tombstone sequences (#3387)
- perf(response-store): index path-prefix selection (#3386)
- perf(response-store): bound manual refresh concurrency (#3371)
- perf(response-store): scope purge work to snapshot (#3372)
- perf(response-store): skip first-write edge purges (#3374)
- perf(response-store): bound tombstone cleanup work (#3384)
- perf(response-store): index cache tag lookups (#3359)
- fix(response-store): retain unaccepted edge purges (#3366)
- fix(response-store): avoid redundant broad purge (#3360)
