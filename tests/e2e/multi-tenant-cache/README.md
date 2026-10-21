# Two-tenant investigation for #3544

This is a runnable investigation scaffold, not an implementation of a new cache
API or a complete fix for [#3544](https://github.com/cloudflare/vinext/issues/3544).

## First experiment

One Node production server receives requests for `tenant-a.test` and
`tenant-b.test` through explicit HTTP Host headers. No DNS setup is needed.

- `/catalog` rewrites to `/tenants/a/catalog` or `/tenants/b/catalog` before
  rendering. The handler reads only the tenant route parameter.
- `/by-host/catalog` reads the hostname while rendering. It is the control for
  vinext's existing dynamic-response behavior.
- Each render gets a UUID, so a cache HIT must prove reuse of stored output.
- `/api/reset` is a test-only endpoint that invalidates the two fixed internal
  catalog paths before a test changes the priming order.

The rewrite tests assert MISS, MISS, HIT, HIT for both A/B/A/B and B/A/B/A. They
investigate whether the maintainer's recommended architecture already provides
independent ISR reuse. A failure is evidence to investigate, not permission to
weaken isolation or dynamic-response admission.

## Run

From the repository root, using the configured mise environment:

```sh
mise exec -- vp run vinext#build
mise exec -- pnpm exec playwright test --config tests/e2e/multi-tenant-cache/playwright.config.mts
```

The dedicated config builds the fixture and starts a production server with
`NODE_ENV=production` on `127.0.0.1:4221`. Stop another service using that port before running. The fixture
reuses app-basic's installed dependencies, following the existing isolated E2E
fixture convention. It is outside the pnpm workspace patterns and requires no
lockfile changes.

## Starting result (October 21, 2026)

At upstream commit `f101c0198`, the test harness reports two passing controls and
two failing cache-reuse cases:

- Direct `/tenants/a/catalog` requests reuse their render and report a HIT.
- `/by-host/catalog` returns each host's content, generates a fresh render for
  each request, and has no shared-cache policy.
- `/catalog` selects the right tenant through the host-conditioned rewrite but
  repeats rendering instead of producing the expected independent cache hits.

The failing assertions are intentional investigation targets. The Next.js comparison below establishes cache reuse for this configuration,
but does not establish that #3544 should be fixed by changing cache keys. No
production cache behavior was changed to obtain these results.

The first relevant decision is already visible in
`packages/vinext/src/server/app-rsc-handler.ts`:
`markConditionalRewriteCacheability()` marks host-conditioned rewrites dynamic
because their selectors are not represented in the shared cache identity. This
is an intentional guard. Preserve it until an alternative identity and admission
contract proves it safe to cache. In particular, passing these tests by simply
deleting that guard would not be a valid solution.

## Next.js reference comparison (October 21, 2026)

The same application files were built with installed Next.js 16.2.7 using
`next build --webpack` and served with `next start`. For A/B/A/B requests to
`/catalog`, the reference returned MISS, MISS, HIT, HIT, correct tenant values,
and distinct per-tenant UUIDs reused on the repeated requests. B/A/B/A requests
also reused the correct tenant responses, with an already warm cache. The reset
endpoint did not reliably make subsequent Next.js sequences cold; cold reverse
priming and repeated invalidation remain unverified.

The unchanged hostname-reading control behaves differently: Next.js prerendered
it with `localhost` and reused that output for both hosts. It does not satisfy
vinext's hostname-isolation control. Preserve vinext's existing safety rule.

This supports investigating reuse of tenant-specific destinations. It does not
prove safety for Response Store, Workers Cache, HTML/RSC, or regeneration.

## Remaining work

1. Build on the Next.js reuse comparison and investigate safe response-stage
   identity for rewritten tenant destinations. Verify cold reverse priming and
   repeated invalidation separately.
2. Add regeneration and revalidation checks that preserve tenant identity.
3. Extend the experiment to App page HTML and RSC/client navigation.
4. Exercise the same architecture with Response Store and then real Workers
   Cache. This Node test does not prove either adapter's behavior; local Wrangler
   does not emulate Workers Cache HITs.
5. Compare with the maintainer's host-free identity stack (#3897, #3898, #3924).
6. Choose the smallest justified contribution: a tested recipe, a missing tenant
   identity mechanism, or a separate multi-domain warming improvement.
7. Define tag scope, alias behavior, and warming requirements before proposing an
   API. Do not change the default admission behavior just to make tests pass.
8. Integrate accepted regression coverage into the normal Playwright projects
   and CI matrix before presenting a submission as complete.

No issue comments, fork creation, pushes, or PR creation are part of this scaffold.
