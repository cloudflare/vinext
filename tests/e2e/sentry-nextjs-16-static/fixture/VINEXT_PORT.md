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
| `package.json` | Replaces Sentry-monorepo packed tarballs and its internal test-utils link with published `@sentry/core` and `@sentry/nextjs@11.0.0-beta.2`, plus vinext/Vite workspace tooling. React and React DOM are updated from 19.1.0 to 19.2.7, Zod is pinned to 3.25.76, and Playwright uses the repository catalog version. All upstream runtime dependencies remain installed. | The published `next` prerelease contains the source fixture's static lifecycle and static-route parameterization behavior without requiring Sentry's monorepo build artifacts. Vinext's matching React Server Components runtime requires React 19.2.6 or newer. The standalone fixture resolves `zod-to-json-schema` 3.25, whose `zod/v3` import requires the compatible Zod 3.25 export that Sentry's monorepo lockfile supplies upstream. A single Playwright installation is required when the fixture runs through the repository's root configuration. |
| `tests/*.test.ts` | Replaces imports from `@sentry-internal/test-utils` with `./test-utils`. | The local helper implements the same event-waiting surface against the repository-local envelope receiver. Test bodies remain otherwise unchanged except where listed below. |
| `tests/build-output.test.ts` | Scans `dist/server` instead of `.next/server`. | vinext's production server output directory is `dist/server`. |
| `tests/db-page.test.ts` | Disables the PostgreSQL/Redis instrumentation case. | This repository does not require Docker-backed services for its Playwright suite. The copied application route and assertions remain available for opt-in compatibility work. |
| `tests/server-components.test.ts`, `tests/route-handler.test.ts`, `tests/parameterized-routes.test.ts`, `tests/isr-routes.test.ts`, `tests/pageload-tracing.test.ts` | Uses the attribute names emitted by the published prerelease: `sentry.source`, `otel.kind`, and underscore-normalized request headers. | The assertions are renamed, not removed; the older names in the pinned test snapshot no longer match its SDK source or published prerelease. |
| `event-proxy.mjs`, `tests/test-utils.ts` | Adds repository-local event receiver utilities. | These replace Sentry-monorepo infrastructure without changing application behavior. The receiver uses `@sentry/core`'s envelope parser and handles transaction, error, metric, check-in, and span-v2 envelope items. |
| Root `playwright.config.ts` and CI matrix | Runs the fixture specs through vinext on port 3030 and the local envelope receiver on port 3031. | This repository owns the app process and CI orchestration rather than Sentry's E2E harness. |

## Environment-specific upstream skips

- The two Vercel AI SDK v3 cases remain upstream `test.fixme` cases because Sentry's channel-based integration does not instrument AI SDK v3. Their upstream comments say to re-enable them after the fixture moves to AI SDK v7 or v3 support returns.
- The async-params case remains skipped in production and belongs to a separate vinext dev-mode run.
- The Turbopack stack-frame case remains skipped because Vite does not produce Turbopack chunks.
- The upstream Edge Route Handler case remains skipped by the fixture itself.

## Validation status

This section is updated with the exact passing, skipped, and parity-gap counts before the draft PR is
submitted.
