---
"@vinext/cloudflare": patch
"vinext": patch
---

- fix(cache): preserve prerendered page cache tags (#709)
- fix(pages-router): load custom \_app/\_document via resolved file paths in dev (#2692)
- fix(pages): preserve live Set-Cookie header arrays (#2689)
- fix(css): load Sass partials from paths containing tildes (#2691)
- fix: honor build --mode dotenv files (#2523)
- fix(build): normalize jsx-in-js module ids on Windows (#2687)
- fix(rsc): handle Windows paths in client reference dedup (#2686)
- fix(app-router): install default not-found boundary (#2670)
- fix(app-router): scope dynamic params by segment (#2228)
- fix(app-router): honor client cache stale times (#2449)
- perf(app-router): serialize streamed metadata once (#2675)
- fix(app-router): resolve interception-only RSC targets (#2256)
- fix(app-router): preserve hash query navigation semantics (#2669)
- fix(pages): normalize decoded edge responses (#2668)
- fix(app-router): reconcile streamed metadata icons (#2320)
- fix(pages): propagate Document script security props (#2044)
- fix(app-router): align prefetch server protocol (#2318)
