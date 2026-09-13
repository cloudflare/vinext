# Next.js worker E2E port

This fixture is ported from Next.js
[`test/e2e/app-dir/worker`](https://github.com/vercel/next.js/tree/2fbeebbaca93e8f478d6b9b97a964ac09ec54faf/test/e2e/app-dir/worker)
at commit `2fbeebbaca93e8f478d6b9b97a964ac09ec54faf`.

The app, worker, WASM, PNG, and public asset files are copied from upstream. The vinext port makes
only these harness adaptations:

- Next.js test utilities are expressed with the repository's shared Playwright fixtures.
- `vite.config.ts` registers vinext with `@cloudflare/vite-plugin` and resolves the already-locked
  `@resvg/resvg-wasm@2.4.0`.
- `next.config.js` uses ESM because vinext production builds require an ESM project.
- The deployment-token listener is scoped to worker-owned requests because vinext deliberately keeps
  ordinary application JavaScript on one unversioned native-ESM module identity.
- Mechanical formatting and narrow type/lint annotations follow vinext's checked-in test rules.
