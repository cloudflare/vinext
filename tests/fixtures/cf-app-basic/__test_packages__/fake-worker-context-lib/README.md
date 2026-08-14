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
- The packages themselves remain bundled because workerd does not provide
  Node-style runtime package resolution. The deliberately missing `import("fail")`
  / `require("fail")` calls are retained, with only `fail` marked external
  in the fixture build. Workerd leaves an unexecuted dynamic import unresolved
  and would report `No such module` only if that unreachable branch ran.
- The upstream `preact/compat` to React alias is omitted because it is unrelated
  to package externalization and this shared Worker fixture already uses React.

The Playwright test additionally asserts that `vinext-externals.json` is empty,
that emitted server modules contain no bare import of this fixture package, and
that the upstream dynamic-import tripwire remains in the output before the same
bundle is executed by Wrangler/workerd. This proves Worker package bundling and
conditional-export parity; it does not claim Node externalization parity.
