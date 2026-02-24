# Troubleshooting

## Common Migration Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `ERR_REQUIRE_ESM` or `require() of ES Module` | Project missing `"type": "module"` | Add `"type": "module"` to package.json |
| `module.exports` syntax error in config file | CJS config loaded as ESM | Rename `.js` config to `.cjs` (e.g., `postcss.config.js` → `postcss.config.cjs`) |
| `Cannot find module '@vitejs/plugin-rsc'` | App Router project missing RSC plugin | `npm install -D @vitejs/plugin-rsc` |
| `Cannot find module 'vite'` | Vite not installed | `npm install -D vite` |
| `vinext: command not found` | vinext not installed or not in PATH | Install vinext: `npm install vinext`, then run via `npx vinext` or package.json scripts |
| RSC environment crash on dev start | Native Node module (sharp, satori) loaded in RSC env | vinext auto-stubs these in production; in dev, ensure these are only imported in server code behind dynamic `import()` |
| `ASSETS binding not found` | wrangler.jsonc missing assets config | Add `"assets": { "not_found_handling": "none" }` to wrangler.jsonc |

## ESM Conversion Issues

When adding `"type": "module"`, any `.js` file using `module.exports` or `require()` will break. Common files that need renaming to `.cjs`:

- `postcss.config.js`
- `tailwind.config.js`
- `.eslintrc.js`
- `jest.config.js` (if kept alongside Vitest)
- `prettier.config.js`

Alternatively, convert these files to ESM (`export default` syntax) and keep the `.js` extension.

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
**Fix:** Check for large dependencies. Use `vinext build` + inspect output size. Consider code splitting or moving large deps to external services.

**Symptom:** Image optimization returns 404 or broken images.
**Cause:** Missing Cloudflare Images binding.
**Fix:** Add `"images": { "binding": "IMAGES" }` and `"assets": { "binding": "ASSETS" }` to wrangler.jsonc.

**Symptom:** ISR pages not caching across requests.
**Cause:** Default `MemoryCacheHandler` doesn't persist across Worker invocations.
**Fix:** Use `KVCacheHandler` from `vinext/cloudflare` with a KV namespace binding. See [config-examples.md](config-examples.md).

## Verification Checklist

After migration, confirm:

- [ ] `vinext dev` starts without errors
- [ ] Home page renders correctly
- [ ] Dynamic routes resolve (e.g., `/posts/[id]`)
- [ ] API routes respond (Pages Router) or route handlers respond (App Router)
- [ ] Client-side navigation works (Link component)
- [ ] Static assets load (images, fonts, CSS)
- [ ] Environment variables (`NEXT_PUBLIC_*`) are available
- [ ] Middleware or proxy.ts executes on matching routes
