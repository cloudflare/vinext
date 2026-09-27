---
"@vinext/cloudflare": minor
"create-vinext-app": minor
"vinext": minor
---

- feat: support direct `vite dev` and `vite build` commands with vinext's development, prerendering, and Cloudflare deployment lifecycle (#3381)
- fix(cloudflare): accept response store account and observability options (#3499)
- feat(cloudflare): support cf Build Output deployments (#3230)
- fix(cache): replay "use cache" params under the original cache key (#3430)
- fix(cache): admit metadata routes to the CDN cache on their own Cache-Control (#3449)
- fix(og): support @vercel/og 1.0.3 on Node and Workers (#3409)
- perf(build): look up action owner modules once per build pass (#3415)
- fix: align Pages Router navigation with Next.js for URL objects, repeated slashes, dynamic routes, and browser history in development and production (#3354, #3367, #3368)
- fix(build): keep browser client out of multi-stage server outputs (#3440)
- fix(cache): keep "use cache" pages with props prerenderable (#3421)
