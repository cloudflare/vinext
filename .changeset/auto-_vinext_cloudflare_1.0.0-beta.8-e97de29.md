---
"@cloudflare/workers-response-store": minor
"@vinext/cloudflare": minor
"vinext": minor
---

- fix(response-store): stabilize cached variant selection (#3308)
- feat(response-store): support for sharded durable objects (#3301)
- fix(check): ignore build output from other toolchains (#3231)
- fix(build): preserve bundled Nitro service exports (#3312)
- fix(server): align user agent parsing with Next.js (#3202)
- fix(pages): serve dynamic Pages Router routes under the Nitro preset (#3197) (#3204)
- fix(cache): expose response store entrypoints in dev (#3306)
- perf(response-store): coalesce binding metadata misses (#3304)
- fix(response-store): index orphan cleanup lookups (#3303)
