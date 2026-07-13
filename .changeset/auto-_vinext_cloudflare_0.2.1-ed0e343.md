---
"@vinext/cloudflare": minor
"vinext": major
---

- feat(init): mark CDN warmup flag experimental (#2533)
- feat(cloudflare): warm prerendered paths before deploy (#2481)
- feat(cloudflare): populate kv cache from prerendered routes (#2509)
- fix(cloudflare): stream deploy logs (#2528)
- fix(init): use built Wrangler config for deploy script (#2532)
- refactor(cloudflare)!: remove vinext package coupling (#2527)
- fix(app-router): stop varying RSC responses by Accept (#2526)
- perf(build): filter virtual module hooks (#2519)
- fix(app-router): preserve client state during action revalidation (#2517)
- fix: dev-server polish batch — HTML charset, client global polyfill, trailingSlash image endpoint (#2512)
- feat(create): add create-vinext-app (#2483)
- fix(check): mark cache components partially supported (#2507)
- fix(config): tsconfig paths — longest-prefix matching and stylesheet-scoped aliases (#2504)
- feat(build): require Vite 8 (#2486)
- feat(init): default to Workers Cache on Cloudflare (#2482)
