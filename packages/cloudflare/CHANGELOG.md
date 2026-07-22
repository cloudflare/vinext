# @vinext/cloudflare

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
