# vinext

## 0.1.0

Today's release contains several app router bundling improvements like code splitting and lazy loading for faster cold starts, and minification by default for smaller bundles. Several CLI crashes were fixed for large projects, and more Next.js parity gaps were addressed.

Vinext now supports additional configuration for caching -- the Vite plugin supports a cache object, where adapters for a data cache and a cdn cache can be supplied. The cdn adapter is intended to be used for route-level caching, while the data adapter is used for everything else, and is used for route caching in the absence of a cdn adapter. This is intended to replace manual setup in the Worker.

```ts
import vinext from "vinext";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

vinext({
  cache: { data: kvDataAdapter() },
});
```

### Features

#### Cache

- extract Cloudflare cache adapters into @vinext/cloudflare (#1748)
- configure cache adapters from vite plugin config (#1733)
- split CDN and data cache adapters; add Cloudflare edge adapter (#1693)

#### Misc

- **Deploy:** honor Worker-entry cache setters for ISR deploys (#1821)
- **PPR:** add PPR fallback-shell render lifecycle tests (#1715)
- **Release:** commit-driven auto-generated changesets (#1753)
- improve dev error overlay source frames (#1746)
- **Skip:** omit proven static layouts from RSC transport (#1437)
- **PPR:** add encodePrerenderRouteParams and match kind exact payload tests (#1714)
- **Skip:** plumb client reuse manifests through the app request path (#1717)
- **App Router:** support useRouter bfcacheId semantics (#1588)

### Bug Fixes

#### App Router

- preserve recent segment state with Activity BFCache (#1739)
- hard navigate streamed redirects (#1742)
- refetch same-page search navigations (#1744)
- match streaming metadata error responses (#1794)
- track searchParams access for static bailout (#1788)
- honor per-response dynamic stale times on the client (#1712)
- ensure streamed SSR body ends with </body></html> (#1532) (#1624)
- emit per-page dynamic stale time metadata (#1711)
- prerender cacheComponents root-param fallback shells (#1702)

#### Build

- share one RSC compatibility ID across all plugin instances (#1814)
- write BUILD_ID via writeBundle so App Router builds emit it (#1810)
- bundle @vinext/cloudflare into vinext to break dependency cycle (#1797)
- emit Next client runtime manifests (#1735)

#### Pages Router

- collapse doubled basePath in client asset URLs (#1730)
- make req async-iterable for bodyParser: false (#1479) (#1678)
- run instrumentation-client.ts before hydration (#1474) (#1671)
- cancel in-flight nav on gSSP/gSP data redirect (#1465) (#1691)

#### Misc

- **Check:** only flag config options used as property keys (#1778)
- **Image:** scan image imports via AST instead of regex (#1779)
- **Image Imports:** normalize meta specifier separators on Windows (#1791)
- **Font:** resolve next/font/local paths inside node_modules packages (#1780)
- **Check:** prevent regex stack overflow / hang on very large files (#1776)
- **Form:** DISALLOWED_FORM_PROPS stripping, file input warning, viewport prefetch, pages-router E2E (#1752)
- **Middleware Runtime:** normalize trailing slash on plain-URL redirect locations (#1750)
- **Routing:** correct (.) interception target for nested slot subdirectories (#1751)
- **OG:** lazy-load @vercel/og to keep it out of the main worker entry (#1774)
- **Config:** avoid duplicate CJS global shims (#1771)
- **Deploy:** respect --env flag when invoking build (#1694)
- **Pages:** render custom errors for notFound results (#1737)
- client HMR dev overlay recovery (#1758)
- **Server:** define CJS path globals in bundled modules (#1740)
- **Link:** full-prefetch dynamic routes without loading shells (#1734)
- **Skip:** centralize final static-layout skip rejection (#1722)
- dev overlay browser sourcemap stacks (#1731)
- **i18n:** make locale sticky across client navigations (#1407)
- **Cache:** attach path tags to prerender-seeded entries so revalidatePath invalidates them (#1486) (#1688)
- **CSS:** preserve distinct media filenames for CSS url() assets (#1725)
- **Metadata:** omit unused parent arg for cached generateMetadata (#1719)

### Performance

- **OG:** dedupe resvg/yoga wasm in server bundle (#1801)
- **Router:** lazy-load App Router page and route-handler modules (#1781)
- **Build:** minify server build environments by default (#1777)
- **Utils:** skip path separator replace on POSIX (#1766)

### Contributors

- @aicayzer
- @Divkix
- @hyoban
- @james-elicx
- @manNomi
- @NathanDrake2406
- @shulaoda
