# ESM externals fixture

The five core routes and six package directories are ported from Next.js
`test/e2e/esm-externals` at v16.2.6, with this repository's formatting applied
and explicit versions added to the paired local packages so pnpm can distinguish
their shared package names:

- `pages/static.js`, `pages/ssr.js`, and `pages/ssg.js`
- `app/server/page.js` and `app/client/page.js`
- `esm-package1`, `esm-package2`, `invalid-esm-package`, `app-esm-package1`,
  `app-esm-package2`, and `app-cjs-esm-package`

Those files intentionally retain the upstream literal `import("fail")` and
`require("fail")` package-externalization sentinels. There is no fixture plugin
or resolver exception for the missing module. The additional routes and
packages cover vinext ownership propagation, aliases, conditional exports, MDX,
dynamic imports, and packages that must remain bundled.
