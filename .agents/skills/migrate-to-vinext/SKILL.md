---
name: migrate-to-vinext
description: Migrates Next.js projects to vinext (Vite-based Next.js reimplementation for Cloudflare Workers). Load when asked to migrate, convert, or switch from Next.js to vinext. Handles compatibility scanning, package replacement, Vite config generation, ESM conversion, and Cloudflare deployment setup.
---

# Migrate Next.js to vinext

vinext reimplements the Next.js API surface on Vite. Existing `app/`, `pages/`, and `next.config.js` work as-is — migration is a package swap, config generation, and ESM conversion. No changes to application code required.

## FIRST: Verify Next.js Project

Confirm `next` is in `dependencies` or `devDependencies` in `package.json`. If not found, STOP — this skill does not apply.

Detect the package manager from the lockfile:

| Lockfile | Manager | Install | Uninstall |
|----------|---------|---------|-----------|
| `pnpm-lock.yaml` | pnpm | `pnpm add` | `pnpm remove` |
| `yarn.lock` | yarn | `yarn add` | `yarn remove` |
| `bun.lockb` / `bun.lock` | bun | `bun add` | `bun remove` |
| `package-lock.json` or none | npm | `npm install` | `npm uninstall` |

Detect the router: if an `app/` directory exists at root or under `src/`, it's App Router. If only `pages/` exists, it's Pages Router. Both can coexist.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `vinext check` | Scan project for compatibility issues, produce scored report |
| `vinext init` | Automated migration — installs deps, generates config, converts to ESM |
| `vinext dev` | Development server with HMR |
| `vinext build` | Production build (multi-environment for App Router) |
| `vinext start` | Local production server |
| `vinext deploy` | Build and deploy to Cloudflare Workers |

## Phase 1: Check Compatibility

Run `vinext check` (install vinext first if needed via `npx vinext check`). Review the scored report. If critical incompatibilities exist, inform the user before proceeding.

See [references/compatibility.md](references/compatibility.md) for supported/unsupported features and ecosystem library status.

## Phase 2: Automated Migration (Recommended)

Run `vinext init`. This command:

1. Runs `vinext check` for a compatibility report
2. Installs `vite` as a devDependency (and `@vitejs/plugin-rsc` for App Router)
3. Adds `"type": "module"` to package.json
4. Renames CJS config files (e.g., `postcss.config.js` → `.cjs`) to avoid ESM conflicts
5. Adds `dev:vinext` and `build:vinext` scripts to package.json
6. Generates a minimal `vite.config.ts`

This is non-destructive — the existing Next.js setup continues to work alongside vinext. Use the `dev:vinext` script to test before fully switching over.

If `vinext init` succeeds, skip to Phase 4 (Verify). If it fails or the user prefers manual control, continue to Phase 3.

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

| Before | After | Notes |
|--------|-------|-------|
| `next dev` | `vinext dev` | Dev server with HMR |
| `next build` | `vinext build` | Production build |
| `next start` | `vinext start` | Local production server |
| `next lint` | `vinext lint` | Delegates to eslint/oxlint |

Preserve flags: `next dev --port 3001` → `vinext dev --port 3001`.

### 3c. Convert to ESM

Add `"type": "module"` to package.json. Rename any CJS config files:

- `postcss.config.js` → `postcss.config.cjs`
- `tailwind.config.js` → `tailwind.config.cjs`
- Any other `.js` config that uses `module.exports`

### 3d. Generate vite.config.ts

See [references/config-examples.md](references/config-examples.md) for config variants per router and deployment target.

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

## Phase 4: Cloudflare Deployment (Optional)

If the user wants to deploy to Cloudflare Workers, the simplest path is `vinext deploy` — it auto-generates `wrangler.jsonc`, worker entry, and Vite config if missing, installs `@cloudflare/vite-plugin` and `wrangler`, then builds and deploys.

For manual setup or custom worker entries, see [references/config-examples.md](references/config-examples.md).

## Phase 5: Verify

1. Run `vinext dev` to start the development server
2. Confirm the server starts without errors
3. Navigate key routes and check functionality
4. Report the result to the user — if errors occur, share full output

See [references/troubleshooting.md](references/troubleshooting.md) for common migration errors.

## Known Limitations

| Feature | Status |
|---------|--------|
| `next/image` optimization | Remote images via @unpic; no build-time optimization |
| `next/font/google` | CDN-loaded, not self-hosted |
| Domain-based i18n | Not supported; path-prefix i18n works |
| `next/jest` | Not supported; use Vitest |
| Turbopack/webpack config | Ignored; use Vite plugins instead |
| `runtime` / `preferredRegion` | Route segment configs ignored |
| PPR (Partial Prerendering) | Use `"use cache"` directive instead (Next.js 16 approach) |

## Anti-patterns

- **Do not modify `app/`, `pages/`, or application code.** vinext shims all `next/*` imports — no import rewrites needed.
- **Do not rewrite `next/*` imports** to `vinext/*` in application code. Imports like `next/image`, `next/link`, `next/server` resolve automatically.
- **Do not copy webpack/Turbopack config** into Vite config. Use Vite-native plugins instead.
- **Do not skip the compatibility check.** Run `vinext check` before migration to surface issues early.
- **Do not remove `next.config.js`** unless replacing it with `next.config.ts` or `.mjs`. vinext reads it for redirects, rewrites, headers, basePath, i18n, images, and env config.
