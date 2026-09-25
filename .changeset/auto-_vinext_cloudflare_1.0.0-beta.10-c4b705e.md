---
"@vinext/cloudflare": patch
"vinext": patch
---

- fix(cache): replay "use cache" params under the original cache key (#3430)
- fix(cache): admit metadata routes to the CDN cache on their own Cache-Control (#3449)
- fix(og): support @vercel/og 1.0.3 on Node and Workers (#3409)
- perf(build): look up action owner modules once per build pass (#3415)
- fix(pages-router): preserve dynamic href history state (#3368)
- fix(pages-router): normalize repeated URL slashes (#3367)
- fix(pages-router): format object as navigation urls (#3354)
- fix(build): keep browser client out of multi-stage server outputs (#3440)
- fix(cache): keep "use cache" pages with props prerenderable (#3421)
