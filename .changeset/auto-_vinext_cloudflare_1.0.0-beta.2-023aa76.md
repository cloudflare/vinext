---
"@vinext/cloudflare": patch
"vinext": minor
---

- fix(cloudflare): report custom-domain deploy URLs (#2630)
- fix(metadata): add meta's 2024 crawler UAs to the html-limited bot list (#2666)
- fix(app): log RSC render errors on the dev-server terminal (#2667)
- perf(build): cache repeated compatibility transforms (#2578)
- fix(router): replace stale optimistic layouts across dynamic params (#2609)
- perf(build): split react-dom/server into its own client chunk (#2604)
- fix(metadata): pass parent to cached resolvers with default or rest p… (#2660)
- fix(link): interpolate Pages Router dynamic hrefs (#2657)
- fix(init): complete an existing Cloudflare config instead of only adding to it (#2653)
- fix(i18n): align Accept-Language locale selection (#2648)
- fix(shims): preserve basePath config in NextURL clones (#2647)
- fix(metadata): pass parent to regular metadata resolvers (#2646)
- fix(fonts): keep immutable font assets query-free (#2605)
- feat(metadata): support viewport fields and parent resolution (#2644)
- fix(font-google): share SSR collection state via globalThis (#2607)
- fix(pages): isolate on-demand revalidation requests (#2495)
- fix(server): defer after callbacks until response close (#2649)
- fix(app-router): stream nested loading boundaries (#2641)
- fix: honor custom TypeScript config path (#2633)
- fix(headers): retain mutable cookie metadata (#2636)
- fix(shims): preserve response cookie metadata (#2635)
- fix(build): support package validation on Windows (#2638)
- fix(shims): reject invalid NextResponse JSON bodies (#2634)
