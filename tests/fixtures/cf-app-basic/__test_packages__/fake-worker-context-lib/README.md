# Worker ESM externals fixture

This package ports the package-shape coverage from Next.js
`test/e2e/esm-externals` into the real Cloudflare Worker fixture. Its export
subpaths preserve the upstream native `.mjs`, `type: module` `.js`, invalid ESM
`.js`, and CommonJS cases. The browser entry keeps the upstream
`process.browser` server guard.

The route matrix and its ten SSR/browser assertions are ported one-to-one:
Pages `/static`, `/ssr`, `/ssg`, and App Router `/server`, `/client`.

There are three harness-only differences:

- The six upstream packages are represented as six export subpaths of this one
  local fixture package. This avoids adding unrelated workspace dependencies
  while preserving each entry's module format and export-condition shape.
- Upstream's deliberately missing `import("fail")` / `require("fail")` calls are
  omitted. They exist to prove Node can leave the packages external. A Worker
  deployment must instead be self-contained; emitting those bare imports makes
  workerd reject the deployment with `No such module`.
- The upstream `preact/compat` to React alias is omitted because it is unrelated
  to package externalization and this shared Worker fixture already uses React.

The Playwright test additionally asserts that `vinext-externals.json` is empty
and that emitted server modules contain no bare import of this package before
the same bundle is executed by Wrangler/workerd.
