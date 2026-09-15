# vinext port notes

## Provenance

- Upstream repository: `getsentry/sentry-javascript`
- Upstream revision: `f97122f4c5047564f438dc7c7661208046341709`
- Upstream path: `dev-packages/e2e-tests/test-applications/nextjs-16-static`
- Exact-copy commit in this repository: `2215f986b`
- Imported coverage: all 25 spec files and all 47 upstream test cases

The exact-copy commit is intentionally followed by compatibility commits. Tests from other Sentry
fixtures must not be moved into this directory.

## Deviations

| Files | Deviation | Reason |
| --- | --- | --- |
| `package.json`, root `pnpm-workspace.yaml` fixture catalog | Replaces Sentry-monorepo tarballs and the internal test-utils link with published `@sentry/core` and `@sentry/nextjs@11.0.0-beta.2`, then adds the vinext/Vite workspace tooling. The fixture-specific Sentry, Next.js, and Zod versions live in the `sentry-nextjs-16-static` catalog; React, React DOM, Playwright, Vite, and Vite Plus reuse the repository catalog. The package is marked as ESM and, like vinext's other fixtures, does not expose the copied application's Next.js build, clean, or test scripts as repository workspace tasks. All upstream runtime dependencies, including `pg` and `ioredis`, remain installed. | The Sentry monorepo tarballs and linked utilities do not exist here. Vinext's React Server Components runtime requires React 19.2.6 or newer. The resolved `zod-to-json-schema@3.25.2` peer dependency requires Zod `^3.25.28 || ^4`, so the fixture pins a compatible Zod 3 release. A single Playwright version avoids loading two incompatible Playwright installations through the root runner. Repository orchestration belongs to the root Playwright configuration; retaining upstream's `clean` (`npx rimraf node_modules pnpm-lock.yaml`) and nested-install scripts would make destructive or networked commands available to workspace-wide task runs. |
| `vite.config.ts` | Adds the minimal `vinext()` Vite configuration and explicitly roots route discovery at this fixture directory. | The upstream fixture is built by Next.js and has no Vite configuration. Explicit `appDir` matches vinext's checked-in fixture convention and prevents invocation location from changing the app root. |
| `tests/*.test.ts` | Replaces imports from `@sentry-internal/test-utils` with `./test-utils`. | The local helper implements the same subset used by these specs against the repository-local envelope receiver. Test bodies remain otherwise unchanged except where listed below. |
| `tests/build-output.test.ts` | Scans `dist/server` instead of `.next/server`. | vinext's production server output directory is `dist/server`. |
| `tests/db-page.test.ts` | Disables the PostgreSQL/Redis instrumentation case. | This repository does not require Docker-backed services for its Playwright suite. The copied application route and assertions remain available for opt-in compatibility work. |
| `tests/openai.test.ts` | Disables the automatic OpenAI Orchestrion instrumentation case. | Unchanged `withSentryConfig()` installs Sentry's Orchestrion webpack plugin in Next.js. Vinext does not execute arbitrary webpack plugins, so the OpenAI package is not transformed to publish the diagnostic event that produces this span. The copied route and assertion remain available if a portable bundler integration is added later. |
| `tests/pageload-tracing.test.ts`, `tests/route-handler.test.ts` | Expects underscore-normalized request-header attribute keys emitted by the published Sentry prerelease. | The assertions are renamed, not removed; the pinned upstream source snapshot expects hyphenated header-name segments. All other transaction and built-in span attribute assertions retain their upstream names. |
| `tests/vercel-cron-monitoring.test.ts`, `tests/suspense-error.test.ts`, `tests/test-utils.ts` | Replaces fire-and-forget negative event waits with awaited, bounded no-match probes. | The upstream helper streams events through a cancellable listener. The repository-local polling receiver needs an explicitly bounded and awaited probe so a late event cannot be missed or leave a rejected promise after the test. |
| `event-proxy.mjs`, `tests/test-utils.ts` | Adds repository-local event receiver utilities. | These replace Sentry-monorepo infrastructure without changing application behavior. The receiver uses `@sentry/core`'s envelope parser and handles transaction, error, metric, check-in, and span-v2 envelope items. |
| Root `pnpm-workspace.yaml`, `playwright.config.ts`, and `.github/workflows/ci.yml` | Installs the fixture as a workspace package and runs all of its specs through vinext on port 3030, with the local envelope receiver on port 3031, as a dedicated production-mode CI project. The app server binds to `::` so its server-side `localhost` fetch retains the upstream `network.peer.address: ::1` assertion. | This repository owns installation, the app process, and CI orchestration rather than Sentry's E2E harness. The copied fixture-local Playwright config, global setup/teardown, and Docker Compose file are retained unchanged for provenance but are not invoked by this project. |
| Root `pnpm-workspace.yaml` Sentry catalog entry | Upgrades the existing repository-wide `@sentry/nextjs` catalog entry from 10.62.0 to 10.74.0. | Existing Cloudflare Sentry fixtures consume the shared stable SDK entry. The imported static fixture does not use it and pins 11.0.0-beta.2 directly. |

## Environment-specific upstream skips

- The two Vercel AI SDK v3 cases remain upstream `test.fixme` cases because Sentry's channel-based integration does not instrument AI SDK v3. Their upstream comments say to re-enable them after the fixture moves to AI SDK v7 or v3 support returns.
- The async-params case remains skipped by its upstream production-mode condition.
- The Turbopack development stack-frame case remains skipped because this project runs a vinext production build; `isTurbopackDevMode` evaluates to false.
- The upstream Edge Route Handler case retains its unconditional `test.skip()`.
- The component-annotation and third-party-filter tests are explicitly skipped because their only feature assertions require Turbopack transforms that Vite does not execute.

## Validation status

The production vinext project discovers all 47 upstream cases. The latest full local run completed
with 38 passing and 9 skipped:

```bash
PLAYWRIGHT_PROJECT=sentry-nextjs-16-static pnpm exec playwright test --workers=1
```

The nine skips are the two upstream Vercel AI SDK v3 `test.fixme` cases, the upstream
production-mode async-params skip, the upstream Edge Route Handler skip, the upstream
Turbopack-development-only skip, the Turbopack-only component-annotation and third-party-filter
cases, and the two documented vinext deviations for DB services and OpenAI Orchestrion.
