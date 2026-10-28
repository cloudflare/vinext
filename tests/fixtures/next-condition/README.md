# `next-js` condition fixture

Ported from Next.js `test/e2e/app-dir/next-condition` at v16.2.6
(`fixtures/render` and `packages/`), reduced to named exports. Each package
resolves a `next-js` × `react-server` matrix through both its `exports` and
`imports` (`#imports`) fields. Next.js selects `next-js` only when Cache
Components is enabled, and never for `serverExternalPackages` loaded by the
server runtime.

`my-barrel-package` is vinext's own addition: a barrel whose root entry has
`react-server`, `next-js` and `default` variants, in that order, imported
through `optimizePackageImports`, and `pages/pages-esm.js` imports the ESM
package from the Pages Router.
