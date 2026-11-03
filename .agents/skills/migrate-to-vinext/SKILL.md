---
name: migrate-to-vinext
description: Migrates Next.js projects to vinext (Vite-based Next.js reimplementation). Load when asked to migrate, convert, or switch from Next.js to vinext. Handles compatibility scanning, package replacement, Vite config generation, ESM conversion, and deployment setup (Cloudflare Workers natively, other platforms via Nitro).
---

# Migrate Next.js to vinext

vinext reimplements the Next.js API surface on Vite. Existing `app/`, `pages/`, and `next.config.js` work as-is — migration is a package swap, config generation, and ESM conversion. No changes to application code required.

## FIRST: Verify Next.js Project

Confirm `next` is in `dependencies` or `devDependencies` in `package.json`. If not found, STOP — this skill does not apply.

Detect the package manager from the lockfile:

| Lockfile                    | Manager | Install       | Uninstall       |
| --------------------------- | ------- | ------------- | --------------- |
| `pnpm-lock.yaml`            | pnpm    | `pnpm add`    | `pnpm remove`   |
| `yarn.lock`                 | yarn    | `yarn add`    | `yarn remove`   |
| `bun.lockb` / `bun.lock`    | bun     | `bun add`     | `bun remove`    |
| `package-lock.json` or none | npm     | `npm install` | `npm uninstall` |

Detect the router: if an `app/` directory exists at root or under `src/`, it's App Router. If only `pages/` exists, it's Pages Router. Both can coexist.

## Quick Reference

| Command                            | Purpose                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `vinext check`                     | Scan project for compatibility issues, produce scored report           |
| `vinext init`                      | Automated migration — installs deps, generates config, converts to ESM |
| `npx vite dev`                     | Development server with HMR                                            |
| `npx vite build`                   | Production build (multi-environment for App Router)                    |
| `vinext start`                     | Local production server                                                |
| `npx @vinext/cloudflare deploy`    | Build and deploy to Cloudflare Workers                                 |
| `vp exec vinext-cloudflare deploy` | Build and deploy to Cloudflare Workers with Vite+                      |

## Phase 1: Check Compatibility

Run `vinext check` (install vinext first if needed via `npx vinext check`). Review the scored report. If critical incompatibilities exist, inform the user before proceeding.

See [references/compatibility.md](references/compatibility.md) for supported/unsupported features and ecosystem library status.

## Phase 2: Automated Migration (Recommended)

Ask the user which deployment target they want (Cloudflare Workers or Node), then pass it with `--platform`. For Cloudflare, also ask for the cache and image choices below. `vinext init` prompts for them only in an interactive terminal: agents and CI must pass all three of `--cdn-cache`, `--data-cache`, and `--image-optimization`, and in an agent session init errors out without them. Do not pick a choice for the user.

```bash
npx vinext init --platform=node
npx vinext init --platform=cloudflare --cdn-cache=none --data-cache=none --image-optimization=none --no-prerender
```

### Cloudflare init flags

| Flag                               | Values                                                                   | Meaning                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cdn-cache`                      | `none`, `response-store`, `workers-cache`, `static-assets`, `data-cache` | Response cache. `none`: no shared cache. `response-store`: Workers Response Store, which also handles data. `workers-cache`: Workers Cache. `static-assets`: read-only build-time prerender. `data-cache`: responses and data both in KV |
| `--response-store-mode`            | `service-binding` (default), `self-contained`                            | Only with `--cdn-cache=response-store`. `service-binding` runs the cache in a separate Worker deployed with `deploy:response-store`; `self-contained` adds its bindings to the app Worker                                                |
| `--data-cache`                     | `kv`, `none`                                                             | Data cache for `fetch`, `unstable_cache`, and `"use cache"`. Must be `none` with `--cdn-cache=none` or `response-store`, and `kv` with `--cdn-cache=data-cache`                                                                          |
| `--image-optimization`             | `cloudflare-images`, `none`                                              | `cloudflare-images` adds `imagesOptimizer()` and an `IMAGES` binding; `none` configures no optimizer                                                                                                                                     |
| `--prerender` / `--no-prerender`   | flag                                                                     | Prerender all static routes at build time. `static-assets` always prerenders and rejects `--no-prerender`                                                                                                                                |
| `--warm-cache` / `--no-warm-cache` | flag                                                                     | Add `--warm-cache` to the deploy script. Only with `--cdn-cache=response-store` or `workers-cache`                                                                                                                                       |
| `--name <name>`                    | Worker name                                                              | Worker name for the generated config (default: derived from `package.json`)                                                                                                                                                              |

Example with Workers Response Store and Cloudflare Images:

```bash
npx vinext init --platform=cloudflare --cdn-cache=response-store --response-store-mode=service-binding --data-cache=none --image-optimization=cloudflare-images --no-prerender --no-warm-cache
```

Other options: `--port <port>` (dev script port, default 3001), `--skip-check`, `--no-install` (add dependency entries without installing), `--force` (Node: overwrite an existing `vite.config.ts`).

### What init does

1. Runs `vinext check` for a compatibility report (skip with `--skip-check`)
2. Adds `"type": "module"` to package.json and renames CJS config files (e.g., `postcss.config.js` → `.cjs`) to avoid ESM conflicts
3. Adds `dev:vinext` (`vite dev --port 3001`), `build:vinext` (`vite build`), and `start:vinext` scripts. `start:vinext` is `vinext start` for Node and `vite preview` for Cloudflare. Cloudflare also gets `deploy:vinext` (`vinext-cloudflare deploy`), plus `deploy:response-store` in Response Store service-binding mode
4. Generates `vite.config.ts`. For Node, an existing Vite config is kept unless you pass `--force`. For Cloudflare, init updates an existing Vite config instead, adding the `cloudflare()` plugin and the selected cache and image adapters, and generates `cloudflare.config.ts` (Worker name, entrypoint, assets routing, and bindings) if it does not exist. With an existing Cloudflare setup:
   - Init leaves an existing `cloudflare.config.ts` untouched, so it does not add the Worker config for newly selected adapters. Add it by hand: `IMAGES: bindings.images()` in the Worker's `env` for Cloudflare Images, and `VINEXT_KV_CACHE: bindings.kv()` for the KV data cache. For Response Store or Workers Cache, merge the helper's whole Worker config from `@vinext/cloudflare/cache/config` into `defineWorker` (in service-binding mode, its `applicationWorker`), not only its `env` bindings. It also sets the Worker's `cache`, and for Workers Cache and self-contained mode its `exports`. Keep the existing `env` and `exports` (see [Caching on Cloudflare](https://vinext.dev/docs/guides/caching)).
   - `--cdn-cache=static-assets` stops if `cloudflare.config.ts` already exists. Configure it manually: keep the assets binding aligned with `staticAssetsAdapter({ binding })` and include `"/_vinext/static-cache/*"` in `assets.runWorkerFirst`.
   - Response Store service-binding mode stops if an existing `cloudflare.config.ts` does not export `responseStoreServiceBinding`, or an existing Vite config does not pass `auxiliaryWorkers: [{ config: responseStoreServiceBinding }]` to `cloudflare()`. Add that wiring, or remove the existing Vite config and rerun init.
5. Adds `/dist/` and `.vinext/` to `.gitignore`, plus `.cloudflare/` for Cloudflare
6. Installs `vinext`, `vite`, and `@vitejs/plugin-react`. App Router adds `react-server-dom-webpack` and `@vitejs/plugin-rsc`. Cloudflare adds `@vinext/cloudflare`, `@cloudflare/vite-plugin` (v2 beta), and `cf`, plus `@cloudflare/workers-response-store` in Response Store service-binding mode

This is non-destructive — the existing Next.js setup continues to work alongside vinext. Use the `dev:vinext` script to test before fully switching over.

### Existing Wrangler config

Cloudflare init stops if the project root already has `wrangler.toml`, `wrangler.json`, `wrangler.jsonc`, or `wrangler.response-store.jsonc`, because it does not migrate them. Ask the user which way to go:

- Move its bindings to `cloudflare.config.ts`, remove the Wrangler config, and rerun init.
- If the Wrangler config belongs to an unrelated Worker, pass `--ignore-wrangler-config`. Init sets up `cloudflare.config.ts` and leaves that file untouched.
- **Legacy:** pass `--legacy-wrangler-cloudflare-init` to keep a Wrangler setup. Init then updates an existing `wrangler.jsonc` or `wrangler.json` in place, or generates `wrangler.jsonc` (it rejects `wrangler.toml`), installs `@cloudflare/vite-plugin@1` and `wrangler`, ignores `.wrangler/`, and uses `wrangler dev --config dist/server/wrangler.json` and `vinext-cloudflare deploy --config dist/server/wrangler.json` as the start and deploy scripts. Use it only when the user wants to stay on Wrangler.

If `vinext init` succeeds, skip Phase 3 and continue with Phase 4 (Deployment) or Phase 5 (Verify). If it fails or the user prefers manual control, continue to Phase 3.

## Phase 3: Manual Migration

Use this as a fallback when `vinext init` doesn't work or the user wants full control.

### 3a. Replace packages

```bash
# Example with npm:
npm uninstall next
npm install vinext
npm install -D vite
# App Router only:
npm install -D @vitejs/plugin-rsc
```

### 3b. Update scripts

Replace all `next` commands in `package.json` scripts:

| Before       | After          | Notes                      |
| ------------ | -------------- | -------------------------- |
| `next dev`   | `vite dev`     | Dev server with HMR        |
| `next build` | `vite build`   | Production build           |
| `next start` | `vinext start` | Local production server    |
| `next lint`  | `vinext lint`  | Delegates to eslint/oxlint |

Preserve Vite-compatible flags: `next dev --port 3001` → `vite dev --port 3001`. Translate Next-only build flags into `vinext()` options in `vite.config.ts` instead of forwarding them to Vite.

### 3c. Convert to ESM

Add `"type": "module"` to package.json. Rename any CJS config files:

- `postcss.config.js` → `postcss.config.cjs`
- `tailwind.config.js` → `tailwind.config.cjs`
- Any other `.js` config that uses `module.exports`

### 3d. Generate vite.config.ts

See [references/config-examples.md](references/config-examples.md) for config variants per router and deployment target.

If the project already has custom Vite config, prefer Vite 8-native keys when editing it: `oxc`, `optimizeDeps.rolldownOptions`, and `build.rolldownOptions`. Older `esbuild` and `build.rollupOptions` settings still work for now but are migration targets.

**Pages Router (minimal):**

```ts
import vinext from "vinext";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [vinext()] });
```

**App Router (minimal):**

```ts
import vinext from "vinext";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [vinext()] });
```

vinext auto-registers `@vitejs/plugin-rsc` for App Router when the `rsc` option is not explicitly `false`. No manual RSC plugin config needed for local development.

### 3e. Update .gitignore

Ensure vinext-generated output and caches are ignored:

```gitignore
/dist/
.vinext/
```

## Phase 4: Deployment (Optional)

### Option A: Cloudflare Workers (recommended for Cloudflare)

Set the project up first with `vinext init --platform=cloudflare` and the flags from Phase 2. It installs `cf` and Cloudflare Vite plugin v2 and generates `cloudflare.config.ts`, which is the deployment source of truth. Commit `vite.config.ts` and `cloudflare.config.ts`; the generated Build Output under `.cloudflare/` stays gitignored.

Authenticate with `npx cf auth login`. In CI, use a `CLOUDFLARE_API_TOKEN` instead of browser login. Set the account with `accountId` at the top level of `defineConfig` in `cloudflare.config.ts` (outside `worker`), or with `CLOUDFLARE_ACCOUNT_ID`.

Deploy with the generated `deploy:vinext` script or `npx @vinext/cloudflare deploy`. With Vite+, use `vp exec vinext-cloudflare deploy` when running the locally installed bin. It validates the setup, builds, and deploys the application Worker with `cf` (or with Wrangler for a legacy Wrangler project). In Response Store service-binding mode, build and run `deploy:response-store` before the first application deploy; `vinext-cloudflare deploy` deploys only the application Worker.

For manual setup or custom worker entries, see [references/config-examples.md](references/config-examples.md).

#### Cloudflare Bindings (D1, R2, KV, AI, etc.)

To access Cloudflare bindings (D1, R2, KV, AI, Queues, Durable Objects, etc.), use `import { env } from "cloudflare:workers"` in any server component, route handler, or server action:

```tsx
import { env } from "cloudflare:workers";

export default async function Page() {
  const result = await env.DB.prepare("SELECT * FROM posts").all();
  return <div>{JSON.stringify(result)}</div>;
}
```

This works because `@cloudflare/vite-plugin` runs server environments in workerd, where `cloudflare:workers` is a native module. No custom worker entry, no `getPlatformProxy()`, no special configuration needed. Just import and use.

Define each binding in the Worker's `env` in `cloudflare.config.ts`, using `bindings` from `cf/config`:

```ts
import { bindings } from "cf/config";

env: {
  // ...existing bindings
  DB: bindings.d1({ name: "my-db" }),
  CACHE: bindings.kv(),
},
```

For TypeScript, add `.cloudflare/types` to the `include` list in `tsconfig.json`. Binding and runtime types are generated there during dev and build; run `cf workers types` before a standalone type-check.

**Legacy:** a project set up with `--legacy-wrangler-cloudflare-init` defines bindings in `wrangler.jsonc` instead and generates types with `wrangler types`.

**IMPORTANT:** Do not use `getPlatformProxy()`, `getRequestContext()`, or custom worker entries with `fetch(request, env)` to access bindings. These are older patterns. `cloudflare:workers` is the recommended approach and works out of the box with vinext.

### Option B: Other platforms (via Nitro)

For deploying to Vercel, Netlify, AWS, Deno Deploy, or any other [Nitro-supported platform](https://v3.nitro.build/deploy), add the Nitro Vite plugin:

```bash
npm install nitro
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [vinext(), nitro()],
});
```

Build and deploy:

```bash
NITRO_PRESET=vercel npx vite build    # Vercel
NITRO_PRESET=netlify npx vite build   # Netlify
NITRO_PRESET=deno_deploy npx vite build  # Deno Deploy
NITRO_PRESET=node npx vite build      # Node.js server
```

Nitro auto-detects the platform in most CI/CD environments, so the preset is often unnecessary.

**Note:** For Cloudflare Workers, Nitro works but the native integration (`npx @vinext/cloudflare deploy` / `vp exec vinext-cloudflare deploy` / `@cloudflare/vite-plugin`) is recommended for the best developer experience with `cloudflare:workers` bindings, KV caching, and one-command deploys.

## Phase 5: Verify

1. Run the generated `dev:vinext` script (or `npx vite dev`) to start the development server
2. Confirm the server starts without errors
3. Navigate key routes and check functionality
4. Report the result to the user — if errors occur, share full output

See [references/troubleshooting.md](references/troubleshooting.md) for common migration errors.

## Known Limitations

| Feature                       | Status                                                                      |
| ----------------------------- | --------------------------------------------------------------------------- |
| `next/image` optimization     | Remote images via @unpic; no build-time optimization                        |
| `next/font/google`            | CDN-loaded, not self-hosted                                                 |
| Domain-based i18n             | Not supported; path-prefix i18n works                                       |
| `next/jest`                   | Not supported; use Vitest                                                   |
| Turbopack/webpack config      | Ignored; use Vite plugins instead                                           |
| `runtime` / `preferredRegion` | Placement ignored; edge App Router pages skip ISR outside `cacheComponents` |
| PPR (Partial Prerendering)    | Use `"use cache"` directive instead (Next.js 16 approach)                   |

## Anti-patterns

- **Do not modify `app/`, `pages/`, or application code.** vinext shims all `next/*` imports — no import rewrites needed.
- **Do not rewrite `next/*` imports** to `vinext/*` in application code. Imports like `next/image`, `next/link`, `next/server` resolve automatically.
- **Do not copy webpack/Turbopack config** into Vite config. Use Vite-native plugins instead.
- **Do not skip the compatibility check.** Run `vinext check` before migration to surface issues early.
- **Do not run Cloudflare init without its choices, or choose them for the user.** Ask the user, then pass `--cdn-cache`, `--data-cache`, and `--image-optimization` (plus `--response-store-mode` for Response Store) explicitly.
- **Do not write `wrangler.jsonc` for a new Cloudflare setup.** Current init uses `cf` and `cloudflare.config.ts`; the Wrangler setup is legacy and only for users who ask for `--legacy-wrangler-cloudflare-init`.
- **Do not remove `next.config.js`** unless replacing it with `next.config.ts` or `.mjs`. vinext reads it for redirects, rewrites, headers, basePath, i18n, images, and env config.
- **Do not use `getPlatformProxy()` or custom worker entries for bindings.** Use `import { env } from "cloudflare:workers"` instead. This is the modern pattern and works out of the box with vinext and `@cloudflare/vite-plugin`.
- **For Cloudflare Workers, prefer the native integration over Nitro.** `npx @vinext/cloudflare deploy` / `vp exec vinext-cloudflare deploy` / `@cloudflare/vite-plugin` provides the best experience with `cloudflare:workers` bindings, KV caching, and image optimization. Nitro works for Cloudflare but the native setup is recommended.
