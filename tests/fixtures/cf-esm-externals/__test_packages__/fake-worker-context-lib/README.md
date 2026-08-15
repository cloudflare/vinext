# Worker ESM conditional-exports fixture

This checked-in package carries the package shapes and route assertions from
Next.js `test/e2e/esm-externals` into a dedicated Cloudflare Worker fixture. Its
export subpaths cover native `.mjs`, `type: module` `.js`, invalid ESM `.js`, and
CommonJS entries. The browser entry retains the upstream `process.browser`
server guard, so the routes verify that Worker RSC/SSR resolution selects the
server `import` entries rather than `browser`.

The five route assertions cover Pages `/static`, `/ssr`, `/ssg` and App Router
`/server`, `/client`. Six upstream packages are represented as export subpaths
of this one local package while preserving their module formats and conditional
export maps.

This fixture does not reproduce Next.js's Node package-externalization
invariant. Worker package code stays bundled because workerd has no Node-style
runtime package resolver. The copied `import("fail")` and `require("fail")`
syntax remains in source, but the fixture plugin externalizes only that missing
specifier and only when imported by this package. That deliberately disables
the syntax's upstream role as a check that the containing package stayed
external: here it covers only workerd's lazy runtime resolution. Rolldown can
accept the deliberately absent module while unrelated unresolved imports still
fail normally.

The Playwright test verifies the route output, that `vinext-externals.json` is
empty, that emitted server modules have no bare import of this fixture package,
and that unreachable missing-import syntax remains in emitted code before
the same output runs under Wrangler/workerd. The exact targeted Next.js E2E is
the separate proof of Node package externalization.
