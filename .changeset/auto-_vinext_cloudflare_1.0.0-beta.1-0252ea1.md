---
"@vinext/cloudflare": patch
"@vinext/types": minor
"create-vinext-app": minor
"vinext": minor
---

- fix(cache): guard 'use cache' key against Cloudflare KV's 512-byte limit (#2606)
- fix(create): make create-vinext-app work with npm and npx (#2618)
- feat(types): ship Next-compatible types without Next.js (#2612)
- fix(check): exclude test-runner files from app compatibility scans (#2596)
- fix(app-router): stream generated metadata after the document shell (#2619)
- fix(cache): isolate draft route responses (#2591)
- fix(middleware): align unsafe matcher validation (#2599)
- fix(pages): match encoded string static paths (#2629)
- fix(dev): refresh routes after server restarts (#2588)
- fix(pages): isolate static render router state (#2583)
- fix(pages): validate redirect destinations consistently (#2586)
- fix(config): keep page extensions out of module resolution (#2594)
- fix(navigation): avoid rewriting URL for history metadata (#2615)
- fix(og): resolve dot-hash wasm fallbacks (#2608)
- fix(router): avoid repeated App path decoding (#2556)
- fix(pages): preserve data route path identity (#2580)
- fix(app-router): preserve Flight stream framing (#2579)
- fix(pages): populate route in app initial props router (#2623)
- fix(shims): align public API with vendored Next types (#2617)
