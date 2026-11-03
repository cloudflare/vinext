# Troubleshooting

## Common Migration Errors

| Error                                         | Cause                                                             | Fix                                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_REQUIRE_ESM` or `require() of ES Module` | Project missing `"type": "module"`                                | Add `"type": "module"` to package.json                                                                                                                                                                                  |
| `module.exports` syntax error in config file  | CJS config loaded as ESM                                          | Rename `.js` config to `.cjs` (e.g., `postcss.config.js` → `postcss.config.cjs`)                                                                                                                                        |
| `Cannot find module '@vitejs/plugin-rsc'`     | App Router project missing RSC plugin                             | `npm install -D @vitejs/plugin-rsc`                                                                                                                                                                                     |
| `Cannot find module 'vite'`                   | Vite not installed                                                | `npm install -D vite`                                                                                                                                                                                                   |
| `vinext: command not found`                   | vinext not installed or not in PATH                               | Install vinext: `npm install vinext`, then run via `npx vinext` or package.json scripts                                                                                                                                 |
| RSC environment crash on dev start            | Native Node module (sharp, @resvg/resvg-js) loaded in Worker code | Workers cannot load Node-API addons: use a Workers alternative (Cloudflare Images, `@resvg/resvg-wasm`), or `resolve.alias` the module to your own file if a dependency imports it on a path that never runs on Workers |
| `Could not load empty-stub.js`                | `resolve.alias` entries written by an older `vinext init`         | Delete the `empty-stub.js` aliases from `vite.config`, and its `path` import if nothing else uses it                                                                                                                    |
| `ASSETS binding not found`                    | Worker config missing the assets binding                          | Add `ASSETS: bindings.assets()` to the Worker's `env` in `cloudflare.config.ts` (legacy Wrangler projects: `"binding": "ASSETS"` in the `assets` block of wrangler.jsonc)                                               |

## Vite 8 Migration Notes

- **Symptom:** deprecation warnings for `esbuild`, `optimizeDeps.esbuildOptions`, or `build.rollupOptions`.
  **Cause:** Vite 8 now defaults to Oxc and Rolldown.
  **Fix:** Prefer `oxc`, `optimizeDeps.rolldownOptions`, and `build.rolldownOptions` / `worker.rolldownOptions` in custom Vite config.

- **Symptom:** a package only breaks on Vite 8 with a bad `default` import from CommonJS.
  **Cause:** Vite 8 made CommonJS default import handling more consistent.
  **Fix:** Fix the import or package if possible. As a temporary workaround, set `legacy.inconsistentCjsInterop: true`.

- **Symptom:** older browsers stop working after migration.
  **Cause:** Vite 8 raised the default `build.target` browser baseline.
  **Fix:** Set `build.target` explicitly in `vite.config.*` if you need older browser support.

## ESM Conversion Issues

When adding `"type": "module"`, any `.js` file using `module.exports` or `require()` will break. Common files that need renaming to `.cjs`:

- `postcss.config.js`
- `tailwind.config.js`
- `.eslintrc.js`
- `jest.config.js` (if kept alongside Vitest)
- `prettier.config.js`

Alternatively, convert these files to ESM (`export default` syntax) and keep the `.js` extension.

## Third-Party Package ESM Resolution Errors

**Symptom:** `Cannot find module '...'` errors in dev server when using certain npm packages.

**Example Error:**

```
Cannot find module '\node_modules.pnpm\validator@13.15.26\node_modules\validator\es\lib\util\assertString'
imported from \node_modules.pnpm\validator@13.15.26\node_modules\validator\es\lib\isEmail.js
```

**Cause:** Some ESM packages have complex internal import structures that Node.js module resolution can't handle when externalized.

**vinext Fix:** vinext sets `noExternal: true` in all server environments (RSC and SSR), which forces all dependencies through Vite's transform pipeline. This resolves extensionless import issues automatically.

**No configuration needed** — this is the default behavior.

## App Router vs Pages Router Issues

**Symptom:** RSC-related errors, "client/server component" boundary violations.
**Cause:** App Router requires `@vitejs/plugin-rsc` for React Server Components.
**Fix:** vinext auto-registers this plugin when it detects `app/`. If auto-registration is disabled (`rsc: false`), enable it or add the plugin manually. See [config-examples.md](config-examples.md).

**Symptom:** `getServerSideProps` / `getStaticProps` not executing.
**Cause:** These are Pages Router APIs. They only work in `pages/`, not `app/`.
**Fix:** This is expected Next.js behavior, not a vinext issue.

## Cloudflare Deployment Issues

**Symptom:** Build succeeds but deploy fails with worker size errors.
**Cause:** Bundle too large for Workers free tier (1 MB) or paid tier (10 MB).
**Fix:** Check for large dependencies. Use `npx vite build` and inspect output size. Consider code splitting or moving large deps to external services.

**Symptom:** Image optimization returns 404 or broken images.
**Cause:** Missing Cloudflare Images binding.
**Fix:** Add `images: { optimizer: imagesOptimizer() }` to `vinext()` and `IMAGES: bindings.images()` to the Worker's `env` in `cloudflare.config.ts`. Legacy Wrangler projects add `"images": { "binding": "IMAGES" }` to wrangler.jsonc instead.

**Symptom:** ISR pages not caching across requests.
**Cause:** Default `MemoryCacheHandler` doesn't persist across Worker invocations.
**Fix:** Configure a persistent cache. On a fresh setup, pass a cache to `vinext init --platform=cloudflare` (for example `--cdn-cache=response-store --data-cache=none`, or `--cdn-cache=data-cache --data-cache=kv` for KV; see the Phase 2 flags table in [SKILL.md](../SKILL.md)). For an existing setup, rerunning init with those flags adds the adapter to the existing Vite config but leaves an existing `cloudflare.config.ts` untouched, so then add only the matching bindings there by hand (see Phase 2, step 4 in [SKILL.md](../SKILL.md) for the cases where init stops instead). Without rerunning init, add both the adapter to `vinext()` and its bindings to `cloudflare.config.ts` by hand, as described in [Caching on Cloudflare](https://vinext.dev/docs/guides/caching).

## Verification Checklist

After migration, confirm:

- [ ] `npx vite dev` starts without errors
- [ ] Home page renders correctly
- [ ] Dynamic routes resolve (e.g., `/posts/[id]`)
- [ ] API routes respond (Pages Router) or route handlers respond (App Router)
- [ ] Client-side navigation works (Link component)
- [ ] Static assets load (images, fonts, CSS)
- [ ] Environment variables (`NEXT_PUBLIC_*`) are available
- [ ] Middleware or proxy.ts executes on matching routes
