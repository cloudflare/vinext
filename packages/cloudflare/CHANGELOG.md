# @vinext/cloudflare

## 1.0.0-beta.7

### Features

#### Cache

- classify and warm static Route Handlers (#3113)
- probe Pages Router cacheability (#3098)
- deploy probed manifests in two stages (#3093)

#### Cloudflare

- configure warmup promotion delay (#3017)
- allow warmup without promotion (#3016)
- prewarm canonical ISR RSC requests (#3002)

### Bug Fixes

#### Cloudflare

- finalize CDN version metadata output (#3137)
- support explicit CDN warm targets (#3138)
- harden post-deploy readiness checks (#3136)
- restore web CDN warmup deploy (#3135)
- classify CDN cacheability per concrete route (#3115)
- discover prewarm paths from staged worker (#3090)
- verify Worker version IDs during CDN warmup (#3072)
- complete warmup response and promotion contracts (#3046)
- harden canonical RSC warmup end to end (#3040)
- default CDN warmup concurrency to 25 (#3015)

#### Misc

- **Cache:** certify staged cache fills before promotion (#3094)
- **Cache:** gate CDN admission on probed routes (#3092)
- **Build:** validate CDN warm discovery and deploy inputs (#3057)

### Contributors

- @james-elicx

## 1.0.0-beta.6

### Bug Fixes

- **Prerender:** cache use-cache metadata routes (#2848)
- **Cache:** delegate CDN header cleanup to adapters (#2797)

### Contributors

- @james-elicx

## 1.0.0-beta.5

### Bug Fixes

- **App Router:** honor cacheLife stale on the client router (#2708)

### Contributors

- @NathanDrake2406

## 1.0.0-beta.4

### Bug Fixes

- **Cache:** preserve prerendered page cache tags (#709)

### Contributors

- @james-elicx

## 1.0.0-beta.3

### Bug Fixes

- **Cloudflare:** report custom-domain deploy URLs (#2630)

### Contributors

- @NathanDrake2406

## 1.0.0-beta.2

### Bug Fixes

- **Cache:** guard 'use cache' key against Cloudflare KV's 512-byte limit (#2606)
- **Create:** make create-vinext-app work with npm and npx (#2618)

### Contributors

- @blitss
- @james-elicx

## 1.0.0-beta.1

### Bug Fixes

- **Build:** honor inline next config for static export (#2543)

### Contributors

- @james-elicx

## 1.0.0-beta.0

### Features

- **Init:** mark CDN warmup flag experimental (#2533)
- **Cloudflare:** warm prerendered paths before deploy (#2481)
- **Cloudflare:** populate kv cache from prerendered routes (#2509)

### Bug Fixes

- **Cloudflare:** stream deploy logs (#2528)

### Contributors

- @james-elicx

## 0.2.1

### Bug Fixes

- **Cloudflare:** respect TPR cache opt-outs (#2493)
- **App Router:** align app static ISR lifecycle (#2472)
- **Cloudflare:** allow pages deploy without custom worker (#2429)

### Contributors

- @james-elicx

## 0.2.0

### Features

- **Build:** support prerender vite config (#2415)
- **Cloudflare:** move deploy command to cloudflare package (#2405)
- **Init:** scaffold for cloudflare and node (#2279)
- **Images:** configure image optimization via vinext({ images }) adapter (#1873)

### Contributors

- @james-elicx

## 0.1.2

### Bug Fixes

- **Cache:** Support stripping CDN ISR headers (#1908)

### Contributors

- @NathanDrake2406

## 0.1.1

### Bug Fixes

- **Cloudflare:** update cache adapter jsdoc and examples (#1898)

### Contributors

- @james-elicx

## 0.1.0

### Features

- **Cache:** extract Cloudflare cache adapters into @vinext/cloudflare (#1748)

### Contributors

- @james-elicx
