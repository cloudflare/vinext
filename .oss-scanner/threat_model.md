# Threat model

## About this project

vinext is a Vite plugin that reimplements the Next.js API surface (App Router,
Pages Router, React Server Components, Server Actions, middleware, ISR, and
the `next/*` modules) so existing Next.js apps build with Vite. Built apps
deploy primarily to Cloudflare Workers, run on Node through `vinext start`, or
reach other platforms through Nitro.

vinext aims for behavioral parity with Next.js. If Next.js 16 behaves the same
way for the same input, the behavior is not a vinext vulnerability, unless
vinext makes it worse.

## Trust boundaries

Every HTTP request that reaches a built app is untrusted. That includes the
path and query, all headers (`X-Forwarded-*`, `RSC`, `Next-Router-*`,
`Next-Action`, `Next-URL`), cookies (including preview and draft mode
cookies), request bodies (Server Action payloads, form data, API route
bodies), image optimization parameters, `_next/data` requests, and
revalidation requests.

Trusted: the application's own source code, `next.config.*`, `vite.config.*`,
environment variables and Worker bindings, npm dependencies, and the build
machine. The operator who runs the deploy CLI is trusted.

`X-Forwarded-Proto` and `X-Forwarded-Host` are trusted only when the operator
sets `VINEXT_TRUST_PROXY=1` or `VINEXT_TRUSTED_HOSTS`
(`packages/vinext/src/server/proxy-trust.ts`).

The dev server runs on the developer's machine. Treat the developer as
trusted, and other websites the developer visits as untrusted.

## Scope

- In scope, most important: `packages/vinext/src/server/` (the request
  pipeline, Node prod server, middleware, routing, Server Actions, ISR and
  caching, image optimization, headers/redirects/rewrites,
  path normalization), `packages/vinext/src/routing/`,
  `packages/vinext/src/shims/` (runtime `next/*` modules such as `headers`,
  `navigation`, `cache`, `image`), and the generated entries under
  `packages/vinext/src/entries/`.
- In scope: `packages/cloudflare/` runtime code (Workers cache adapters, image
  handling) and `packages/workers-response-store/` (the Durable Object backed
  response cache).
- In scope, lower priority: the dev server (`dev-server.ts`,
  `dev-origin-check.ts`), the build plugins under `packages/vinext/src/plugins/`
  and `packages/vinext/src/build/`, the deploy CLI in `packages/cloudflare/`,
  and `packages/create-vinext-app/`.
- Out of scope: `examples/`, `benchmarks/`, `apps/web/` (the docs site),
  `tests/`, `scripts/`, `.github/`, `packages/types/`, and test files.

## How to exercise it

- Packages resolve each other through `dist/`. Run `vp run build` after
  changing anything under `packages/`.
- Run one unit test file with `vp test run --project unit tests/<file>.test.ts`.
- Run one integration test file with
  `vp test run --project integration tests/<file>.test.ts`. These build fixture
  apps from `tests/fixtures/` and can take a minute or more.
- To run a real app, build a fixture and start the Node prod server:
  `cd tests/fixtures/app-basic && pnpm exec vinext build && pnpm exec vinext start --port 3000`.
  `tests/fixtures/pages-basic` covers the Pages Router.
- Playwright e2e suites are defined in `playwright.config.ts`; select one with
  `PLAYWRIGHT_PROJECT=<name> pnpm exec playwright test`. Chromium is installed.
- Tests that install packages from the npm registry or deploy to Cloudflare
  need network access and do not work offline.

## How you rate severity

Rate impact on a production app built with vinext using default settings. In
order of priority:

1. Remote code execution on the server, or invoking a Server Action or server
   function the app did not export
2. Reading server files, server-only modules, or environment secrets, or
   leaking server-only code into client bundles
3. Middleware or route-level auth bypass, for example through path
   normalization that differs between the middleware matcher and the router
4. Cache poisoning or cross-user cache leaks: one user's personalized response
   (cookies, auth, `headers()`) served to another, or attacker-controlled
   content stored for everyone in ISR, the Workers Cache, or the Response
   Store
5. Server-side request forgery through image optimization or rewrites
6. XSS in framework-generated HTML or inline scripts, open redirects, and
   response header injection

Denial of service is low. Dev-server findings that need the developer to visit
a malicious page are at most medium. Findings that need a non-default setting
are rated lower, not excluded.

## Anything to leave alone

- Behavior that matches Next.js 16 for the same input
- Bugs inside React itself (`react`, `react-dom`, `react-server-dom-webpack`);
  vinext uses the copy installed in the app and does not patch React
- Missing authorization checks in application code, such as a Server Action
  or route handler the app wrote without checking the session
- Findings that need a malicious `next.config.*`, `vite.config.*`, dependency,
  environment variable, or build machine
- Responses a CDN stores because of `Cache-Control` headers the app set itself
- Cache entries from an older deployment or Worker version; caches are scoped
  per deployment version
- Files the Vite dev server serves when the app sets `server.fs.strict: false`
- `X-Forwarded-*` spoofing when the operator has enabled `VINEXT_TRUST_PROXY`
  or `VINEXT_TRUSTED_HOSTS`
- Hardcoded secrets in tests, fixtures, and examples
