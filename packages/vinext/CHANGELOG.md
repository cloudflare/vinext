# vinext

## 1.0.0-beta.3

### Features

- **Metadata:** support viewport fields and parent resolution (#2644)

### Bug Fixes

#### Metadata

- add meta's 2024 crawler UAs to the html-limited bot list (#2666)
- pass parent to cached resolvers with default or rest p… (#2660)
- pass parent to regular metadata resolvers (#2646)

#### Shims

- preserve basePath config in NextURL clones (#2647)
- preserve response cookie metadata (#2635)
- reject invalid NextResponse JSON bodies (#2634)

#### Misc

- **App:** log RSC render errors on the dev-server terminal (#2667)
- **Router:** replace stale optimistic layouts across dynamic params (#2609)
- **Link:** interpolate Pages Router dynamic hrefs (#2657)
- **Init:** complete an existing Cloudflare config instead of only adding to it (#2653)
- **i18n:** align Accept-Language locale selection (#2648)
- **Fonts:** keep immutable font assets query-free (#2605)
- **Font Google:** share SSR collection state via globalThis (#2607)
- **Pages:** isolate on-demand revalidation requests (#2495)
- **Server:** defer after callbacks until response close (#2649)
- **App Router:** stream nested loading boundaries (#2641)
- honor custom TypeScript config path (#2633)
- **Headers:** retain mutable cookie metadata (#2636)
- **Build:** support package validation on Windows (#2638)

### Performance

- **Build:** cache repeated compatibility transforms (#2578)
- **Build:** split react-dom/server into its own client chunk (#2604)

### Contributors

- @akim136
- @blitss
- @Boyeep
- @james-elicx
- @MrIago
- @NathanDrake2406
- @piffie
- @ponharu

## 1.0.0-beta.2

### Features

- **Types:** ship Next-compatible types without Next.js (#2612)

### Bug Fixes

#### Pages

- match encoded string static paths (#2629)
- isolate static render router state (#2583)
- validate redirect destinations consistently (#2586)
- preserve data route path identity (#2580)
- populate route in app initial props router (#2623)

#### Misc

- **Check:** exclude test-runner files from app compatibility scans (#2596)
- **App Router:** stream generated metadata after the document shell (#2619)
- **Cache:** isolate draft route responses (#2591)
- **Middleware:** align unsafe matcher validation (#2599)
- **Dev:** refresh routes after server restarts (#2588)
- **Cache:** guard 'use cache' key against Cloudflare KV's 512-byte limit (#2606)
- **Config:** keep page extensions out of module resolution (#2594)
- **Navigation:** avoid rewriting URL for history metadata (#2615)
- **OG:** resolve dot-hash wasm fallbacks (#2608)
- **Router:** avoid repeated App path decoding (#2556)
- **App Router:** preserve Flight stream framing (#2579)
- **Shims:** align public API with vendored Next types (#2617)

### Contributors

- @blitss
- @exKAZUu
- @james-elicx
- @lyzno1
- @NathanDrake2406

## 1.0.0-beta.1

### Bug Fixes

#### App Router

- preserve streamed metadata placement parity (#2572)
- delay dynamic SSR stream pulls (#2575)
- handle redirects in route-miss fallbacks (#2553)
- preserve semicolons in redirect digests (#2487)

#### Pages

- preserve missing page props on errors (#2568)
- align preview mode behavior (#2561)
- mark auto exports in next data (#2569)
- normalize i18n router URLs (#2565)
- preserve fast refresh state (#2544)

#### Misc

- **Build:** gate native typeof window folding (#2574)
- pass server externals to Nitro traceDeps (#2521)
- **Build:** honor inline next config for static export (#2543)
- **Routing:** discover dot-directory routes (#2531)

### Performance

- **Build:** use native typeof window folding (#2564)
- **Pages:** reuse dev stylesheet dependency analysis (#2550)

### Contributors

- @james-elicx
- @LubomirGeorgiev
- @NathanDrake2406
- @WilliamK112

## 1.0.0-beta.0

### Features

- **Init:** mark CDN warmup flag experimental (#2533)
- **Cloudflare:** warm prerendered paths before deploy (#2481)
- **Cloudflare:** populate kv cache from prerendered routes (#2509)
- **Create:** add create-vinext-app (#2483)
- **Build:** require Vite 8 (#2486)
- **Init:** default to Workers Cache on Cloudflare (#2482)

### Bug Fixes

- **Init:** use built Wrangler config for deploy script (#2532)
- **App Router:** stop varying RSC responses by Accept (#2526)
- **App Router:** preserve client state during action revalidation (#2517)
- dev-server polish batch — HTML charset, client global polyfill, trailingSlash image endpoint (#2512)
- **Check:** mark cache components partially supported (#2507)
- **Config:** tsconfig paths — longest-prefix matching and stylesheet-scoped aliases (#2504)

### Performance

- **Build:** filter virtual module hooks (#2519)

### Contributors

- @camc314
- @james-elicx
- @southpolesteve

## 0.2.1

### Bug Fixes

#### App Router

- limit mounted slot cache variants (#2497)
- omit pending RSC cache state for query renders (#2488)
- isolate global not-found css (#2444)
- expose app rewrites to pages data clients (#2468)
- publish committed no-prefetch navigations (#2469)
- cache segment prefetches by rendered search params (#2477)
- skip readiness waits for speculative prerenders (#2457)
- align app static ISR lifecycle (#2472)
- reuse metadata rewrite prefetches (#2455)
- avoid runtime route-tree prefetch sizing (#2467)
- start optimistic prefetches immediately (#2440)
- normalize rsc reference validation ids (#2480)
- send deployment id on RSC responses (#2452)
- separate header-only full-route rsc requests (#2445)
- preserve app rewrite filtering (#2441)
- revalidate dynamic intercepted actions (#2443)
- evict segment prefetches under memory pressure (#2466)
- honor basePath false rewrites (#2370)
- preserve rewritten route identity (#2358)
- support styled-jsx from next (#2341)

#### Pages

- align middleware data prefetch caching (#2451)
- honor basePath false rewrites (#2442)
- normalize data routes for trailing slash middleware (#2470)
- align prerender functional parity (#2471)
- enforce reactStrictMode by wrapping client root in <StrictMode> (#2433)
- preload initial dev stylesheets (#2423)
- route dotted dynamic paths in dev (#2424)

#### Misc

- fully elide inline type-only import specifiers (#2498)
- **Config:** escape destination query params (#2494)
- **Link:** avoid reusing dynamic app route prefetches (#2450)
- **Build:** handle dynamic requests in JS files with JSX (#1736)
- **Dev:** treat .js as JSX in the optimizeDeps scanner (#2434)
- **Config:** resolve and bundle extensionless .cjs config imports (#2435)
- **CSS:** preserve Sass partial asset URLs (#2338)
- **Link:** reuse full prefetch loading shells (#2332)
- **Dev:** seed Cloudflare Pages Router worker deps (#2430)
- **Cloudflare:** support Sentry request errors on Workers (#2425)
- use normalizePathSeparators in formatAppFilePath for Windows compatibility (#2426)
- **Routing:** use normalizePathSeparators(path.relative) instead of path.posix.relative (#2308)

### Performance

- **Build:** parallelize prerender across a pool of render processes (#2437)

### Contributors

- @hyf0
- @james-elicx
- @kushdab
- @NathanDrake2406
- @shulaoda
- @southpolesteve

## 0.2.0

Today's release includes a revamped `vinext init` command, moving the deploy command to `npx @vinext/cloudflare deploy`, more support for configuring vinext in your Vite config file, and a bunch of bug fixes.

When you run `vinext init` in a project, you will be prompted to choose a target (e.g. 'cloudflare' or 'node'), and all configuration for that target will be done as part of the init command. This replaces the need to run `vinext deploy` to setup a cloudflare project. Projects using `vinext deploy` should switch to `npx @vinext/cloudflare deploy` - the previous command will be removed in a future release, and they are functionally the same.

Cloudflare builds no longer need the custom worker file that used to be generated for applications. You can now point your wrangler config to target a vinext-managed fetch handler that takes care of the generic entry under-the-hood.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": "vinext/server/fetch-handler",
}
```

When removing the custom worker, you can configure your image optimisation provider and prerendering config in your Vite config.

```ts
import vinext from "vinext";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

vinext({
  images: { optimizer: imagesOptimizer() },
  // exclude the prerender config altogether if you do not need prerendering.
  prerender: {
    // only '*' is supported at the moment, more configurability will come in future releases.
    routes: "*",
  },
});
```

### Features

- **Build:** support prerender vite config (#2415)
- **Cloudflare:** add unified worker entry (#2416)
- **Cloudflare:** move deploy command to cloudflare package (#2405)
- **Init:** scaffold for cloudflare and node (#2279)
- **Images:** configure image optimization via vinext({ images }) adapter (#1873)

### Bug Fixes

#### App Router

- match generated params case-insensitively (#2351)
- honor basePath opt-out rewrites (#2362)
- preserve layouts across soft navigation (#2316)
- preserve primary parallel route slot (#2347)
- preserve named parallel slot state (#2246)
- avoid repeated hover prefetches (#2396)
- reuse committed client cache payloads (#2251)
- normalize trailing slash in implicit cache tags (#2390)
- scroll past existing hoisted styles (#2356)
- include page segment in flight state (#2359)
- discover nested leaf slot routes (#2350)
- restore intercepted history slots (#2363)
- preserve interception across middleware rewrites (#2342)
- honor global not found opt-in (#2340)
- replay prerendered preload headers (#2333)
- bind layout-only children defaults (#2335)
- scope static params across parallel routes (#2317)
- skip prefetches for bots (#2323)
- render templates with children only (#2322)
- align static dynamic params parity (#2321)
- avoid probing client references (#2313)
- match dynamic request analysis parity (#2253)

#### Build

- resolve framework-owned SWC helpers (#2357)
- keep dynamic third-party imports bare in published dist (#2395)
- align SSR CSS asset paths (#2291)

#### Pages

- pass req res to document initial props (#2402)
- expose parsed cookies on request objects (#2401)
- match optional catch-all prerender paths (#2238)

#### Pages Router

- retain prefetched SSG data (#2366)
- unify client asset bootstrap (#2378)
- split scanned file paths on forward slashes (#2297)

#### Misc

- **Init:** only detect pnpm approve-builds failures from pnpm-specific output (#2404)
- **Server:** restore client trace metadata parity (#2371)
- **CSS:** support namespace CSS Module imports (#2345)
- **Link:** start viewport prefetches immediately (#2229)
- **Router:** honor middleware app rewrites for page links (#2339)
- **Form:** match Next.js navigation parity (#2245)
- **Client:** isolate Pages Router module graph (#2380)
- **Image:** match App Router deploy parity (#2310)
- **Cache:** bypass unstable cache in draft mode (#2319)
- **CLI:** respect Vite dev server config (#2379)
- **Cache:** throw updateTag context errors synchronously (#2311)
- **Config:** match trailing-slash route sources (#2255)
- **Config:** match deprecation warning parity (#2252)
- **Middleware:** match Pages data request metadata (#2239)
- **Actions:** match root params execution phases (#2248)

### Performance

- **Metadata:** cache scanMetadataFiles to skip the redundant 2nd per-build app-tree walk (#2394)
- **Plugins:** skip dynamic-request AST parse for static-import-only modules — 5000-route build −21% (#2392)
- **Routing:** cache app-route-graph directory reads — 5000-route build −32% (#2389)

### Contributors

- @Boyeep
- @hyf0
- @james-elicx
- @MaxtuneLee
- @shulaoda

## 0.1.8

### Bug Fixes

#### App Router

- exclude dev overlay from production client bundle (#2284)
- match interception route precedence (#2231)
- preserve global error details (#2249)
- restore cache and parallel route parity (#2261)
- canonicalize initial history URL (#2250)

#### Misc

- **Build:** apply default server externals (#2257)
- **SSR:** ignore runtime renderer import in Vite (#2288)
- **Router:** ignore stale initial popstate with i18n (#2230)
- **Middleware:** run on missing build assets (#2242)
- **Headers:** strip internal dev request ID headers (#2260)
- **Pages Router:** allow server-only in API routes (#2234)
- **Config:** make vite-tsconfig-paths an optional peer (#2258)

### Performance

- **App Router:** skip speculative page probes for HTML renders (#2226)
- **Link:** omit Pages runtime in app-only builds (#2225)
- **Client:** omit unused server action client (#2222)
- **App:** omit unused PPR runtime (#2223)
- **App:** omit unused file metadata runtime (#2224)

### Contributors

- @hyoban
- @james-elicx
- @ponharu
- @southpolesteve
- @TheAlexLichter

## 0.1.7

### Bug Fixes

- **Image:** emit hoisted var for local image import binding to avoid TDZ (#2067)
- **Dynamic:** render ssr:false loading with pastDelay:true to match client (#1967) (#2064)
- **Actions:** dedupe Set-Cookie on no-JS non-redirect action responses (#1976) (#2063)
- **RSC:** only short-circuit well-known signal digests so real errors reach onRequestError (#2066)

### Performance

#### App

- omit unused server action runtime (#2206)
- omit unused metadata route runtime (#2196)
- omit unused middleware runtime (#2194)

#### Misc

- **Server:** skip duplicate App RSC vary merge (#2177)
- **Server:** reuse App SSR bfcache metadata (#2182)
- **Client:** preserve additional route-owned shims (#2205)
- **Dev:** externalize SSR React runtime (#2191)
- **App Router:** isolate action request detection (#2188)
- **Client:** preserve App Router route chunk boundaries (#2189)
- **OG:** use MagicString positional overwrites instead of repeated replaceAll (#2202)
- **Dev Server:** memoize the Pages SSR handler across dev requests (#2201)
- **Mdx:** gate the MDX transform handler behind a native id filter (#2200)

### Contributors

- @Divkix
- @NathanDrake2406
- @shulaoda
- @TheAlexLichter

## 0.1.6

### Bug Fixes

- **OG:** constrain inlined assets to trusted roots (#2172)
- **Router:** enhance navigation with `as` mask for URL handling (#2076)
- **Proxy:** match Next.js file conventions (#2155)
- **Prod Server:** send headers-only for HEAD in sendCompressed (#1980) (#2058)
- **RSC:** resolve the app-rsc-handler shim to a forward-slash id on Windows (#2165)
- **Init:** ignore vinext output directory (#2160)
- **App Router:** block dangerous RSC redirect URLs (#2154)
- **Fonts:** preload only requested google font subsets (#2152)
- **Server:** q-value-aware Accept-Encoding negotiation (#2047)
- **Image:** resolve aliased static imports (#2142)

### Performance

- **App Router:** defer layout, template and boundary modules to first request (#2145)
- **App Router:** defer prerender endpoint & file metadata runtimes (#2150)

### Contributors

- @Divkix
- @james-elicx
- @jillesme
- @MaxtuneLee
- @NathanDrake2406
- @shulaoda
- @TheAlexLichter

## 0.1.5

### Bug Fixes

- **Image:** preserve unoptimized remote URLs (#2139)
- **Image Imports:** normalize watchChange id so image cache invalidates on Windows (#2125)
- **Transforms:** emit sourcemaps from strip-server-exports and remove-console (#2124)
- **Middleware:** match middleware taint ids by forward-slash on Windows (#2088)
- **Build:** normalize canonicalized module ids to forward slashes on Windows (#2089)
- **CSS:** keep module hashes stable with url assets (#2114)
- **Middleware:** normalize trailing slash before matching (#2112)

### Performance

#### Dev

- skip JSX transform for compiled runtime (#2121)
- skip typeof window folding for prebundles (#2118)
- externalize App Router request handler (#2108)

#### Misc

- **App Router:** defer cache-only runtimes (#2126)
- **App Page Cache:** reuse HTML ISR key during regeneration (#2127)
- **App Page Cache:** reuse the ISR cache key on the stale-regeneration path (#2123)
- **Image Imports:** hoist image-extension regex to module scope (#2122)
- **SSR:** isolate open redirect detection (#2120)
- **Build:** rely on plugin hook filters (#2119)
- **App Router:** defer action and route-handler runtimes (#2079)
- **Cache:** isolate handler and request state (#2107)
- **Build:** filter compatibility transform hooks (#2103)

### Contributors

- @james-elicx
- @shulaoda
- @TheAlexLichter

## 0.1.4

### Bug Fixes

#### Pages

- emit canonical **NEXT_DATA** JSON (#2043)
- re-enter filesystem routes after rewrites (#2041)
- apply Document renderPage enhancers (#2034)
- interpolate same-segment rewrite params (#2030)
- honor basePath in dev module loaders (#2033)
- route hybrid form data requests (#2029)
- preserve rewritten URLs during navigation (#2028)

#### Misc

- **Build:** preserve lazy RSC framework chunks (#2074)
- **Middleware:** fail closed for unsafe matchers (#2078)
- **Build:** strip server-side Pages data export transforms from client (#2055)
- **Fonts:** detect trailing comma past comments when injecting font options (#2051)
- **Csp:** match script-src-elem/attr when extracting script nonce (#2049)
- **Script:** register src beforeInteractive scripts and mark hoisted output (#2019)
- **i18n:** match NEXT_LOCALE cookie case-insensitively (#2050)
- **Metadata:** gate twitter app and player tags on card type (#2053)
- **Config:** support tsconfig extends array form (#2054)
- **Navigation:** promote OperationToken to the eligibility authority (#2009)
- **App Router:** preserve dynamic interception source routes (#2042)
- **Image:** emit static imports as managed assets (#2040)
- **Middleware:** classify Pages data requests by URL (#2039)
- **Pages Router:** cancel deduped GSSP data waits (#2038)
- **Router:** re-enter filesystem routes after rewrites (#2032)
- **Actions:** return body-limit errors without closing responses (#2026)
- **Router:** render slots beside grouped children (#2022)
- **App Router:** settle superseded link navigations (#2025)
- **Prerender:** deduplicate generateStaticParams entries (#2031)

### Performance

- **RSC:** prebundle static renderer entry (#2077)
- **Dev:** prune NODE_ENV during dependency optimization (#2075)

### Contributors

- @Divkix
- @james-elicx
- @MaxtuneLee
- @NathanDrake2406
- @TheAlexLichter
- @Xplod13

## 0.1.3

### Bug Fixes

#### App Router

- align router autoscroll with Next (#2004)
- recover SSR shell render errors via **next_error** document (#1908)
- preserve front redirects through fallback route handlers (#2000)
- expose active source page on window.next (#1995)
- fold typeof window before resolution (#1956)
- support extensionless variable imports (#1958)
- preserve page notFound precedence during metadata failure (#1957)

#### Deploy

- preserve app module identity with deployment ids (#2005)
- prevent Windows shell injection (#1946)
- improve deployment id parity (#1949)

#### Pages

- preserve app props for GSSP requests (#1996)
- preserve module identity with deployment ids (#2012)
- harden cookie parsing (#1947)

#### Pages Router

- pass rewrite URL to edge API requests (#1998)
- block fallback shell for crawler UAs on prerender (#1543) (#1663)
- restore scroll across reload history traversal (#1905)

#### Router

- honor hybrid pages route priority (#1997)
- share Pages Router context across chunks (#2010)
- restore pages scroll traversal state (#1999)
- hard navigate Pages links to App routes (#1960)

#### Shims

- guard AsyncLocalStorage construction for browser bundles (#2020)
- add useUntrackedPathname hook for error boundary parity (#1933)
- match next/error RSC diagnostic (#1939)

#### Misc

- **Image:** allow any quality 1-100 when images.qualities is unset (#2023)
- **Server:** strip HTTP/2 pseudo-headers before building Headers (#2021)
- **Prerender:** surface thrown generateStaticParams/getStaticPaths errors (#2017)
- **Routing:** re-encode trailing-slash Location for non-Latin-1 paths (#2011)
- **PPR:** gate fallback shells until request-time resume is supported (#1716)
- **Build:** honour experimental.lightningCssFeatures include/exclude (#1498) (#1664)
- **Image:** prevent optimizer cache-key amplification (#1944)
- **Actions:** bound Flight payload graph validation (#1942)
- **Link:** preserve basePath hash navigation (#1952)
- **Headers:** prioritize config cache headers for metadata assets (#1953)
- **Config:** share CommonJS module fallback (#1990)
- **Config:** honor resolve extensions and improve webpack config processing (#1959)
- **CSS:** load local CommonJS PostCSS plugins (#1961)
- **Cache:** honor fetch opt-outs and force-dynamic revalidate parity (#1907)

### Performance

- skip unnecessary import parsing (#1991)
- cache fs probes and precompute route sort keys in scan/deploy paths (#1930)

### Contributors

- @Divkix
- @james-elicx
- @JaredStowell
- @NathanDrake2406
- @Xplod13

## 0.1.2

### Bug Fixes

#### App Router

- include parallel slot params in useParams (#1904)
- preserve unstable_catchError boundaries (#1906)
- suppress redirect console errors in production onCaughtError (root-layout-redirect) (#1878)
- preload next/dynamic chunks with CSP nonce (#1594)
- extend OTel tracer provider for Cache Component span context (#1868)
- return HTTP 200 when notFound() is thrown from generateMetadata (#1864)
- discover parallel-slot pages inside route groups for catch-all + parallel-routes-group (#1865)

#### Pages Router

- support stream proxying in API routes (#1902)
- set x-nextjs-deployment-id on SSG \_next/data responses (#1863)
- buffer SSR response for crawler/bot User-Agents (#1876)
- hard-navigate to App Router destinations from Pages Router links (#1879)
- bridge deprecated Router.on<Event> property callbacks (#1869)

#### Misc

- **Router:** support experimental gesture push (#1909)
- **Prod Server:** stop double-evaluating the server bundle when chunks import the entry back (#1924)
- **Trailing Slash:** canonical url trailing slash support (#1888)
- **Edge Wasm:** handle `*.wasm?module` imports in non-Cloudflare builds (#1877)
- **Config:** define cache components flag as boolean (#1903)
- **Scss:** preprocess SCSS CSS-module composes deps via SassAwareFileSystemLoader (#1882)
- **Routing:** normalize route root to forward slashes, drop downstream path workarounds (#1896)
- **Middleware:** clear nextUrl.basePath for absolute paths outside basePath (part of #1830) (#1872)
- **Cloudflare:** update cache adapter jsdoc and examples (#1898)
- **Fonts:** normalize shims dir so shim-skip guards match on Windows (#1885)
- **Check:** normalize scanned file paths to forward slashes on Windows (#1887)
- **Shims:** use path.posix.join in resolveShimModulePath for Windows (#1886)
- **Scss:** resolve tilde (~) imports from node_modules and project root (#1881)
- **Build:** define process.env.NEXT_RUNTIME for server bundles (#1880)
- **Build:** inline ../-relative font assets in OG routes (#1866)
- **Use Cache:** pass soft tags to cache lookup so revalidatePath invalidates use-cache entries in route handlers (#1867)

### Performance

- **Server:** eliminate redundant per-request parsing in the request pipeline (#1929)
- **Server:** hoist per-request regex compilation out of SSR streaming and shim hot paths (#1915)

### Contributors

- @Divkix
- @james-elicx
- @jgeurts
- @MaxtuneLee
- @NathanDrake2406
- @shulaoda

## 0.1.1

### Bug Fixes

#### App Router

- match Pages navigation params in hybrid builds (#1741)
- include route pattern in repeated-slash Link warning (#1554) (#1855)
- scroll to top with hoisted children and loading.js (#1368) (#1857)
- resolve explicit parallel slot with no page (#1535) (#1852)
- propagate "use cache" tags to route-handler ISR entries (#1453) (#1848)
- resolve query-only Link href against current path (#1540) (#1844)
- render built-in fallback when global-error.tsx throws (#1548) (#1837)
- clear useLinkStatus pending after interrupted navigation (#1527) (#1839)
- respect reactMaxHeadersLength for preload Link header (#1552) (#1841)
- preserve \_rsc query across redirects (#1529) (#1838)
- apply trailingSlash to route handler request URL (#1827) (#1835)
- restore scroll snapshots on back (#1743)
- isolate page CSS chunks in production (#1738)

#### Build

- correct CSS ordering for global-not-found (#1549) (#1858)
- exclude Vite build manifests from Cloudflare asset uploads (#1850)
- don't crash on benign floating asset-import errors (#1510) (#1846)
- expand require.context into import.meta.glob map (#1501) (#1836)
- don't path-resolve bare specifier aliases for esmExternals (#1507) (#1843)
- don't crash build when a PostCSS string plugin can't be resolved (#1509) (#1840)

#### Misc

- **Pages Router:** pass revalidateReason "on-demand" to gsp/gssp (#1462) (#1856)
- **Actions:** return 404 for MPA action on app with no server actions (#1340) (#1853)
- **Routing:** propagate middleware draft cookie to pages/api fallback (#1520) (#1845)
- **Actions:** enforce serverActions.bodySizeLimit on fetch actions (#1828) (#1834)
- support sibling-style interception routes (#1804)

### Contributors

- @Divkix
- @james-elicx
- @NathanDrake2406

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

## 0.0.55

### New Features

- Added experimental `appShells` configuration option with validation support
- Added support for Sparkle experimental flags: `varyParams`, `optimisticRouting`, and `cachedNavigations`
- Added layout safety observation foundations for improved skip optimization
- Added static layout reuse proof model for better performance analysis

### Bug Fixes

- Fixed app router navigation to better align with Next.js behavior
- Fixed Pages Router to properly run `_document.getInitialProps` with renderPage enhancers
- Fixed Head component to preserve charset and viewport defaults during client hydration
- Fixed Pages Router to deduplicate in-flight `_next/data` fetches by URL to prevent redundant requests
- Fixed Head component to match Next.js charset/viewport ordering and properly merge `_document.getInitialProps` head elements
- Fixed TypeScript `next.config` loading to keep packages externalized
- Fixed TypeScript config resolution to properly handle `baseUrl` imports from `tsconfig.json`
- Fixed server-only imports to work correctly from 'use server' modules
- Fixed fnv1a64 hash function to produce consistent fixed-width output
- Fixed App Router to preserve forwarded action redirect wrappers
- Fixed App Router to reuse pending prefetched RSC payloads for better performance
- Fixed App Router to preserve middleware headers on metadata routes
- Fixed Pages Router to preserve `import.meta.url` source paths
- Fixed server-only imports to be properly rejected from client-reachable modules

### Performance

- Improved memory management with bounded default cache size and LRU eviction
- Enhanced ISR cache key generation to include i18n context for better cache accuracy

### Internal / Chores

- Updated `@vitejs/plugin-rsc` dependency to version 0.5.27
- Added regression test for parallel slot page-over-default priority

### Contributors

@NathanDrake2406
@james-elicx
@southpolesteve
@Divkix

## 0.0.54

### New Features

- Added support for inline CSS parity in App Router
- Implemented `compiler.define` and `compiler.defineServer` configuration options
- Added `compiler.removeConsole` build option to strip console statements

### Bug Fixes

#### App Router

- Fixed static-sibling info inclusion in SSR responses
- Fixed caching for pages with `revalidate=Infinity` or `revalidate=false`
- Fixed module-only Vite reference errors now properly treated as action-not-found
- Fixed `forbidden()` and `unauthorized()` to properly escalate past intermediate layouts
- Fixed client prefetch cache to honor `experimental.staleTimes` configuration
- Fixed routing to treat `@children` as transparent so explicit pages win over catchalls
- Fixed action Set-Cookie header deduplication by name
- Fixed `icons.other` metadata to accept single descriptor format
- Fixed `draftMode()` reads inside cache scopes
- Fixed cookie and header propagation from server actions without JavaScript
- Fixed global-not-found chunk isolation to prevent CSS cascade issues
- Fixed `unstable_rootParams` propagation to actions and route handlers
- Fixed spacing in streamed error meta tags
- Fixed autoscroll preservation across page refreshes
- Fixed `updateTag` to throw proper error when called outside Server Actions
- Fixed source identity preservation for intercepted renders
- Fixed default autoscroll page target behavior

#### Pages Router

- Fixed `Document.getInitialProps` invocation so document props reach SSR
- Fixed app route detection during prefetch operations
- Fixed custom `pages/500` rendering on SSR errors
- Fixed non-serializable `getStaticProps`/`getServerSideProps` error handling
- Fixed page script emission with defer attribute in `<head>` by default
- Fixed `useParams` snapshot stabilization for SSR
- Fixed static page responses to return 405 with proper `Allow` header for invalid methods
- Fixed 404 responses for invalid `_next/static` requests in worker deployment

#### General

- Fixed Next.js script stylesheets to emit proper `<link rel="stylesheet">` tags
- Fixed `unstable_retry` to throw proper Pages Router parity error
- Fixed webpack loader side effects to apply `process.env` mutations
- Fixed build process to inline `process.env.NEXT_DEPLOYMENT_ID` for client and worker bundles
- Fixed OpenTelemetry to inject `experimental.clientTraceMetadata` into SSR head
- Fixed build to forward `pageExtensions` to Vite resolve extensions
- Fixed middleware to stop merging original query into rewrite targets
- Fixed Link component `href`/`onClick` forwarding in `legacyBehavior` mode
- Fixed React DOM prop name translation to HTML attributes in hoisted scripts
- Fixed route handler Set-Cookie default `Path=/` when merging mutable cookies
- Fixed routing precedence when both `pages/_foo.tsx` and `app/` directory exist
- Fixed development favicon.ico handling to avoid expensive 404 renders

### Performance

- Moved `normalizePathSeparators` utility to shared path utils
- Reused `normalizePathSeparators` for static file cache path handling

### Internal / Chores

- Added comprehensive test coverage for Link component onClick/preventDefault behavior
- Added regression tests for API route dispatch with middleware
- Added trailing slash enforcement tests for App Router
- Added regression tests for URL-encoded CSS paths
- Added shallow Router.push redirect bypass tests
- Added edge runtime and OG image API route tests
- Added metadata regression test for dynamic icon hrefs
- Added Link component OnNavigate fixture tests
- Added form action regression tests
- Added various other regression and edge case test coverage

### Contributors

@Divkix
@NathanDrake2406
@james-elicx
@manNomi
@shulaoda

## 0.0.53

### New Features

- Added support for `nextConfig.instrumentationClientInject` configuration option
- Pages Router now consumes `_next/data` JSON endpoint from the client, improving data fetching behavior

### Bug Fixes

#### Security Fixes

- Fixed bodyParser configuration to be properly honored in Pages API routes
- Fixed `x-forwarded-proto` header handling in Edge API runtime when `trustProxy` is disabled
- Bounded cache key cardinality for `x-vinext-mounted-slots` to prevent potential issues
- Kept draft mode secrets out of client-side defines to prevent exposure

#### App Router

- Fixed RSC navigation scroll targeting to align with Next.js behavior
- Fixed prerender parameter encoding to be properly preserved
- Fixed dynamic route parameter key ordering to match expected behavior
- Fixed history index preservation when external state writes occur
- Fixed metadata file exports for static App Router builds
- Fixed metadata streaming for non-HTML bot requests
- Fixed Edge runtime header application across all App Router response paths
- Fixed Vary header emission on Edge RSC route responses
- Fixed 307 status code preservation on document loads during prerender
- Fixed router.prefetch to properly throw errors on invalid URLs
- Fixed inline beforeInteractive script hoisting above resource hints

#### Pages Router

- Fixed basePath error route rendering when masked
- Fixed `revalidateReason` parameter passing to `getStaticProps` and improved default Cache-Control headers
- Fixed Promise-shaped `getServerSideProps` props to be properly awaited
- Fixed dangerous URI scheme detection to throw errors synchronously
- Fixed query string preservation in Link component and router.push calls
- Fixed default Cache-Control headers on `getServerSideProps` responses
- Fixed router push/replace methods to properly return Promise<boolean>
- Fixed head element attributes to use `data-next-head` instead of `data-vinext-head`

#### Other Fixes

- Fixed 404 page default copy to match Next.js exactly
- Fixed image optimization to emit proper `/_next/image` URLs
- Fixed server action redirects to properly resolve relative URLs
- Fixed Pages Router middleware redirect handling
- Fixed static file cache path normalization on Windows
- Fixed cache request data to be properly marked as private
- Fixed relative URL error handling in NextRequest to throw canonical errors
- Fixed font binding family preservation for local fonts
- Fixed stale build output cleanup before rebuilds
- Added warning when legacy middleware filename is detected
- Added warning for repeated forward slashes in Link href props

### Contributors

@james-elicx
@NathanDrake2406
@Divkix
@jgeurts
@manNomi
@shulaoda
@ikxin

## 0.0.52

### New Features

- Added native App Router route type generation via CLI
- Introduced cache reuse proof system for static layout artifacts with cross-checks
- Implemented `_next/data` JSON endpoint for Pages Router
- Added support for `onNavigate` prop in Next.js Link components
- Exposed `window.next.router` on hydration in Pages Router
- Added experimental `appShells` configuration plumbing
- Added disabled ClientReuseManifest protocol support

### Bug Fixes

#### Router & Navigation

- Fixed route hybrid pages API fallbacks to properly route through pages entry
- Fixed deployment fallback hard navigations in App Router
- Preserved default locale for unprefixed root links
- Fixed parameter isolation for root-params in prerendering and SSR
- Normalized trailing slash behavior for routing parity
- Fixed route priority preservation on middleware rewrite target resolution
- Rendered optimistic loading shells for dynamic App Router navigation
- Rendered loading shell for unlisted `fallback: true` paths in Pages Router

#### Internationalization (i18n)

- Normalized default-locale paths before route matching
- Stripped locale prefix for API routes
- Honored `locale: false` setting on rewrites/redirects with proper default-locale redirect
- Preserved i18n client root navigation in Pages Router

#### Middleware

- Allowed server-only imports in middleware
- Preserved query parameters on rewrite
- Fixed redirect protocol with relative Location and x-nextjs-redirect headers

#### App Router

- Parsed interception route markers in route scanner
- Resolved nested slot pages over default.tsx in parallel routes
- Emitted metadata from parallel route slots
- Prerendered layout static params
- Returned 404 + x-nextjs-action-not-found for missing actions

#### Pages Router

- Honored `shallow` prop on next/link
- Avoided getServerSideProps identifier collision during build
- Wrapped edge API requests in NextRequest with bare runtime export support
- Guarded navigation shim against SSR
- Executed edge API routes with Fetch Request

#### Caching & Performance

- Preserved Next.js cache headers for prerendered app pages
- Wired next/after to Workers ctx.waitUntil in deploy mode

#### Assets & Styling

- Set default assetsDir to `_next/static` for Next.js parity
- Supported data URL composes in CSS modules

#### Configuration & Base Path

- Enforced trailing slash configuration in routing and middleware redirects
- Enforced base path scoping on rewrites/redirects/routes
- Applied basePath and route via Pages Router for form soft navigation
- Added deprecation warning for experimental.rootParams

#### Metadata & URLs

- Matched Next.js metadata image route behavior
- Fixed usePathname to return canonical URL after middleware rewrite
- Warned on blocked javascript: URL navigation
- Passed `params: null` instead of `{}` for non-dynamic routes

#### Error Handling & Flight

- Matched Next.js default error page UI
- Returned flight payload (200) for RSC navigations on redirects
- Awaited top-level await module imports

### Performance

- Pre-installed compatible React in deploy harness for faster e2e tests

### Internal / Chores

- Migrated font-google tests from fetch hijacking to MSW
- Introduced MSW infrastructure for testing
- Extracted Playwright cache plumbing into composite action
- Split e2e compatibility testing by App Router vs Pages Router
- Refactored navigation runtime topology

### Contributors

@Divkix
@JamesbbBriz
@NathanDrake2406
@james-elicx
@lyzno1

## 0.0.51

### New Features

- Implemented assetPrefix config with full Next.js semantics (path-prefix and absolute-URL forms, basePath fallback)
- Added App Router support for app/global-not-found.tsx (Next.js 16 parity)
- Added dev server lock file to prevent concurrent dev sessions
- Added manifest-backed interception topology to the App Router
- Planned App Router navigation from RouteManifest topology
- Promoted intercepted route preservation through the navigation planner
- Recorded App Router render observations in the caching layer
- Classified private and dynamic render downgrades in the cache
- Added static layout proof and variant budget guardrails to the cache
- Added support for declared artifact compatibility sets
- Added /compatibility page backed by D1 + deploy-suite ingest

### Bug Fixes

- Matched Next dynamic route semantics for metadata routes
- Applied ancestor templates to title defaults in metadata
- Threaded basePath through metadata, manifest, and redirects
- Emitted streamed redirect and not-found meta tags
- Rendered progressive action not-found HTML on the server
- Threw a typed error for unrecognized server actions
- Modeled RSC redirect and traversal lifecycle
- Hard-navigated stale RSC build payloads
- Hydrated initial root in a transition
- Kept refresh transitions pending until completion
- Refreshed after discarded revalidating actions
- Skipped RSC navigation for hash-only history traversal
- Tracked hash-only traversal metadata
- Guarded stale popstate scroll restoration
- Preserved history metadata for external state updates
- Promoted default slot persistence through route state
- Forwarded searchParams correctly in probePage()
- Matched Next.js RSC Content-Type and 404 plain-text body
- Added x-action-forwarded guard to prevent server action forwarding loops
- Surfaced invalid dynamic usage errors via Flight in dev
- Populated useParams/useSearchParams under the Pages Router
- Included \_app module assets in served page HTML
- Shared pages useRouter state through context
- Derived shallow dynamic params from the URL
- Kept next/router import free of popstate side effects
- Supported string paths and missing params in getStaticPaths
- Decoded hash scroll targets
- Threw when App Router context is missing during navigation
- Supported prefetch invalidation callbacks
- Gated intercept matching on Next-URL source pattern
- Aligned visible and intent prefetching for next/link
- Normalised next/link href for trailingSlash config
- Preserved native URI scheme navigation (mailto:, tel:, etc.) in next/link
- Preserved native download clicks in next/link
- Preserved unsafe href click handlers in next/link
- Cleared blur placeholder after image load
- Emitted preload hints for priority images
- Preserved fill positioning for remote images
- Preserved inline styles on remote images
- Excluded ipaddr.js from SSR dep optimizer
- Preloaded <script> sources during SSR via ReactDOM.preload
- Honored async={false} for client scripts
- Deduped concurrent same-src script loads
- Treated draftMode() as non-dynamic; mark dynamic only on enable()/disable()
- Added unstable_catchError, unstable_rethrow, unstable_isUnrecognizedActionError shims
- Matched Next.js font result style semantics
- Attached inner "use cache" call site as cause of nested-dynamic error
- Preserved binary inlined Flight chunks
- Preserved exported client reference subpaths
- Allowed JSX in .js client modules inside node_modules
- Pinned cssTarget so esbuild preserves max-width media-query syntax
- Emitted SSR CSS assets referenced by SSR entry
- Passed sassOptions from next.config to the Vite preprocessor
- Recognized next.config.mts and interop CJS imports in the config loader
- Loaded CJS next.config.js under "type": "module"
- Provided CJS globals when loading next.config.ts
- Parsed route exports with the OXC AST in build report
- Exposed AsyncLocalStorage as a global in the edge runtime
- Cleared browser globals before SSR user modules
- Fixed next build failure for the app-router-playground example

### Internal / Chores

- Updated @vitejs/plugin-rsc to 0.5.26
- Bumped Node to 24 in CI for native URLPattern support
- Cached WebKit apt archives and skipped browser install on cache hit
- Added test-path filter input to nextjs-deploy CI
- Defaulted deploy-suite CI to all suites and disabled test retries
- Added basic vinext site
- Updated oxc editor settings
- Added next-env.d.ts to .gitignore
- Clarified middleware.ts deprecation warning is non-fatal
- Deduped push/replace logic in next/router shim
- Consolidated edge globals into installEdgeGlobals() helper
- Shared interception matched-url validation in the router
- Extracted shared static-paths normalization in prerender
- Added regression coverage for next.config runtime value shapes
- Added regression tests for issue #1196 (catch-all route params with basePath + rewrites + middleware)
- Sequenced link.js and importActual to fix link-navigation flake
- Extracted CJS→ESM converter to standalone deploy-suite script
- Handled **dirname, **filename, and require.resolve in CJS→ESM converter
- Injected jiti when deploy-suite test apps use TypeScript config files
- Applied tsconfig.compilerOptions.paths when loading next.config.ts in deploy-suite
- Handled missing optional deps in deploy-suite test fixture configs
- Bumped pinned sass below ^1.70.0 for Vite 8 in deploy-suite
- Created .next/trace before build to avoid ENOENT noise on build failure
- Used correct workers.dev URL for compat ingest

### Contributors

- @james-elicx
- @NathanDrake2406
- @Divkix
- @GHX5T-SOL

## 0.0.50

### New Features

- Added `window.next` global for better Next.js compatibility
- Implemented `next/cache` stable `io` export (deprecated `unstable_io`)
- Added `useReportWebVitals` hook support
- Added support for `images.dangerouslyAllowLocalIP` configuration to reject private IP addresses
- Enabled JSX syntax in plain `.js` files for Next.js compatibility
- Added `waitForAllReady` support for prerender/ISR parity

### Bug Fixes

- Fixed missing runtime default export in `next/app` shims
- Added `withRouter` HOC to `next/router` shims
- Added `unstable_cacheLife` and `unstable_cacheTag` to `next/cache` shims
- Added placeholder `bfcacheId` to `useRouter` hook
- Fixed client reference loading issues
- Fixed auto prefetch fetching dynamic app routes
- Fixed dangerous HTML preservation during client sync in head component
- Fixed app router prefetch scheduling alignment
- Fixed redirect digest handling and loading.tsx rendering during cross-route navigation
- Fixed UI preservation during action refresh
- Fixed form state preservation after hydration with `useActionState`
- Fixed noSSR initial delay state preservation in dynamic components
- Fixed redirect type context preservation
- Fixed draft mode status to be live in headers
- Fixed basePath hash-only page navigation handling
- Fixed config headers preservation on middleware redirects
- Fixed progressive RSC stream truncation errors
- Fixed Next.js dynamic component overload forms acceptance
- Fixed filesystem routes preservation before afterFiles rewrites
- Fixed incomplete loading props in dynamic components
- Fixed RSC vary headers appending in finalizer
- Fixed request API promise identity reuse
- Fixed private IP rejection support in image optimization
- Fixed Suspense fallback streaming during draft mode in App Router
- Fixed identical render fetch deduplication
- Fixed link navigation scheduling as transitions
- Fixed cache key scoping by deployment id
- Fixed non-ASCII character encoding in cache tags
- Fixed action revalidation header emission
- Fixed middleware header preservation on cached pages
- Fixed Windows shell execution for execFileSync calls
- Fixed middleware request body isolation
- Fixed indefinite app page cache entry reading
- Fixed credentials preservation for external override rewrites
- Fixed app page cache bypass in draft mode
- Fixed RSC action notFound HTTP fallback status
- Fixed route group error boundary handling
- Fixed repeated hard-navigation loop prevention
- Fixed NextResponse.next status preservation

### Performance

- Improved prerender performance by reusing embedded RSC payload

### Internal / Chores

- Added Next.js deploy suite harness for testing
- Promoted mounted parallel slot preservation
- Promoted segment reset semantics
- Promoted same-layout ancestor persistence
- Added root-boundary navigation decision planning
- Exposed RouteManifest semantic facts and segment boundary information
- Enabled stricter promise and error linting rules
- Upgraded pnpm from v10 to v11 with frozen lockfile enabled
- Hardened ecosystem fixture startup for testing
- Extracted internal HTTP header names into shared constants

### Contributors

@james-elicx
@hyoban
@NathanDrake2406
@manNomi
@fengmk2
@arpitjain099
@Yoinky3000
@Deepam02
@Divkix
@evil1morty

## 0.0.49

### Bug Fixes

- Fixed route parameter resolution to correctly prioritize Pages Router route params over query parameters with the same key
- Updated React Server Components initialization to align with React 19.2.6 compatibility requirements

### Contributors

@southpolesteve

## 0.0.48

### New Features

- Added concurrency control flag for prerendering operations
- Added route graph manifest read model for better routing introspection
- Added artifact compatibility metadata for App Router deployments
- Added navigation trace reason-code system for debugging client-side routing
- Added semantic route graph identifiers for improved routing analysis
- Added visible commit version tracking for browser state management
- Added disabled cache proof model for server-side caching scenarios
- Server startup logging is now displayed during prerendering

### Bug Fixes

- Fixed ISR app cache regeneration to be variant-safe, preventing cache inconsistencies
- Fixed SSR external module handling (`ssr.external: true`) in App Router configurations
- Fixed middleware execution by properly stripping internal headers
- Fixed route refresh and traversal outcomes with proper gating logic
- Fixed `generateStaticParams` validation errors to propagate correctly
- Fixed server action argument decoding with proper size limits
- Fixed App RSC route-match path canonicalization
- Fixed stale server action commits from being processed
- Fixed Windows deployment issues with wrangler .CMD shim resolution
- Fixed parallel slot route rendering for layout-only configurations
- Fixed dynamic segment name parsing to accept any non-`]` characters (Next.js parity)
- Fixed metadata merge behavior and Twitter card inheritance to match Next.js
- Fixed nested parallel slot sub-route discovery from layout-only parents
- Fixed `redirect()` and `notFound()` handling under `loading.tsx` components
- Fixed well-known property protection in thenable params implementation
- Fixed URL parameter decoding using `decodeURIComponent`
- Fixed invalid HTTP method handling in App route handlers (now returns 400)
- Fixed RSC cache-busting parameter validation
- Fixed `revalidate = false` support for App route segment configuration
- Fixed non-standard robots directive support via `other` field
- Fixed `generateStaticParams` error handling to catch errors per-source rather than per-loop
- Fixed internal Next.js header filtering from inbound requests

### Performance

- Improved ISR performance by caching misses from streamed renders
- Optimized client reference preloads by coalescing multiple requests

### Internal / Chores

- Updated Next.js dependency version
- Updated React dependency version
- Extensive internal refactoring to dedupe common patterns and utilities across the codebase
- Removed unused deprecated exports from shims
- Enhanced test coverage for App Router navigation lifecycle and root-layout behavior

### Contributors

@NathanDrake2406
@james-elicx
@jgeurts
@piffie

## 0.0.47

### New Features

- Added React-based runtime error overlay for better development experience

### Bug Fixes

- Fixed layout segment configuration not being properly applied to pages in App Router
- Fixed routing issues where inherited slot parameters were incorrectly matched against request URL instead of route path
- Fixed parallel slots not being properly mirrored to descendant sub-pages
- Fixed CLI validation to properly reject missing or malformed `--port` and `--hostname` values
- Fixed Google Fonts to be self-hosted in development mode instead of making external requests
- Fixed hydration errors in `next/image` component by adding proper error replay handling
- Fixed navigation to properly fall back to hard navigation when render errors tear down the component tree
- Fixed HMR to trigger full page reload when render errors destroy the browser root
- Fixed HMR timing issues by ensuring router state is ready before dispatching RSC updates
- Fixed ISR to properly honor route expiration ceilings

### Performance

- Moved private Next.js instrumentation client out of Vite's dependency optimization for faster dev builds

### Internal / Chores

- Refactored App RSC request lifecycle into typed handler for better maintainability
- Extracted response finalization logic into dedicated server module
- Extracted request normalization into separate typed server module
- Refactored browser navigation lifecycle controller for better separation of concerns
- Extracted page element building logic into typed helper modules
- Extracted app fallback renderer factory for better code organization
- Moved instrumentation lazy initialization to dedicated server module
- Extracted App Router route graph builder into separate module
- Moved route classification injection behind typed planner interface
- Added code review guidelines for AI agent
- Updated project README
- Added test coverage reporting for integration tests
- Removed obsolete code assertion tests and snapshots
- Fixed various linting issues

### Contributors

@NathanDrake2406
@james-elicx
@Divkix

## 0.0.46

### New Features

- Added support for file metadata routes in App Router head output
- Added `unstable_io` shim for `next/cache` to handle asynchronous operations during prerendering
- Added `next/offline` shim with `useOffline()` hook
- Added `next/root-params` shim for accessing root-level parameters
- Added `ForbiddenBoundary` and `UnauthorizedBoundary` components for HTTP access fallback recovery

### Bug Fixes

- Fixed `next/image` component to only fire `onError` callback once per source per mount
- Fixed App Router to avoid unnecessary reloads when colocated files change during development
- Fixed import paths by replacing relative shim imports with bare specifier `vinext/shims/X`
- Fixed stream error handling in ISR cache to prevent incomplete data by re-throwing errors in pumpReader
- Fixed error boundaries in App Router to properly preserve falsy thrown values
- Fixed `unstable_io()` to no longer return hanging promises during prerendering
- Fixed support for `enablePrerenderSourceMaps` config (defaults to true)
- Fixed support for `experimental.outputHashSalt` config and `NEXT_HASH_SALT` environment variable
- Fixed client-side navigation errors to properly forward invalid dynamic usage errors in development
- Fixed draft mode cookie attributes to align with Next.js behavior
- Fixed optional catch-all route parameters to omit empty params
- Fixed stale server actions to return "action-not-found" response
- Fixed support for `experimental.swcEnvOptions` config
- Fixed route-level boundary nesting order to match Next.js behavior
- Fixed metadata route suffix exemption list to align with Next.js
- Fixed cache handler config to support `file://` URLs
- Fixed ISR background revalidation errors to be reported via `onRequestError`
- Fixed static metadata URL resolver (`fillStaticMetadataSegment`)
- Fixed `next/font/google` runtime registrations for better stability
- Fixed cache request leaks in App Router
- Fixed middleware cookie handling and external rewrites alignment
- Fixed layout parameter scoping and error boundary handling
- Fixed cached pages to be properly tagged by route pattern
- Fixed cookie precedence preservation in App Routes
- Fixed SSR render and head collection serialization in Pages Router
- Fixed symlink path resolution in standalone package copy
- Fixed static pages to return 405 status for non-action mutations
- Fixed route handlers to reject middleware control responses
- Fixed server-inserted HTML flushing during SSR streaming
- Fixed invalid app route discovery conflicts to be properly rejected
- Fixed RSC client shims to be excluded from dependency optimization

### Performance

- Optimized RSC stream processing by reducing allocations from 3 to 2 tees

### Internal / Chores

- Refactored metadata route pattern helpers for better code sharing
- Extracted app page dispatch logic for better organization
- Extracted RSC runtime primitives for improved modularity
- Extracted early request pipeline helpers
- Shared config support list across compatibility checks
- Extracted app prerender endpoints
- Extracted app route handler dispatch
- Extracted server action RSC flow
- Extracted app RSC manifest construction
- Delegated RSC preload hint normalization
- Delegated RSC route matching

### Contributors

@NathanDrake2406
@Divkix
@james-elicx

## 0.0.45

### New Features

- Implemented complete Next.js Google Fonts support with proper metadata and URL pipeline

### Bug Fixes

- Fixed hash anchors not being restored during browser history navigation
- Fixed stale cache entries not being served properly for `unstable_cache`
- Fixed cache entries not being properly scoped by build ID
- Fixed `NextRequest.url` normalization issues through `nextUrl`
- Fixed action redirects not working correctly in App Router
- Fixed parallel slot routing issues for layouts before the root
- Fixed ownerless URL commits incorrectly releasing snapshots
- Fixed `revalidatePath` not properly expiring route-scoped fetch cache reads
- Fixed dev server crashes from socket errors when clients disconnect unexpectedly
- Fixed middleware headers not being preserved on app boundary responses
- Fixed router accepting dangerous `javascript:` URLs in push/replace/prefetch operations
- Fixed incorrect layout segment selection for named slots
- Fixed Google Fonts axis range validation and build-time option checking
- Enhanced dev server error output to surface `Error.cause` for better debugging

### Internal / Chores

- Updated PostCSS from 8.5.3 to 8.5.10
- Fixed Knip configuration issues
- Various CI improvements and dependency updates

### Contributors

@NathanDrake2406
@MrIago
@james-elicx
@dependabot[bot]

## 0.0.44

### Bug Fixes

- Fixed protocol-relative URL handling to properly guard against percent-encoded delimiters
- Fixed `usePathname` hydration snapshot issues in codex
- Fixed hard navigation to browser URL when RSC fetch returns non-ok response in app router
- Fixed `isPending` state to remain true across RSC-level redirects in app router

### New Features

- Added support for rendering intercept route layouts inside App Router slots

### Internal / Chores

- Added knip for dead code elimination
- Updated bonk to opus 4.7
- Bumped opencode version

### Contributors

@southpolesteve
@james-elicx
@NathanDrake2406

## 0.0.43

### Bug Fixes

- Fixed App Router navigation to properly maintain loading states during programmatic navigation with `router.push()`
- Fixed routing issues with sibling intercepted routes in App Router applications
- Fixed cache headers for route handlers with `revalidate: 0` to properly emit `no-store` Cache-Control directive

### Contributors

@NathanDrake2406

## 0.0.42

### New Features

- Static and dynamic layout detection for skip-header optimization to improve performance
- Layout classification system with build-time wiring into RSC entry points
- Per-layout flags now emitted in RSC payload for better rendering control
- Flat keyed payload system for App Router layout persistence
- Enhanced interception context encoding in App Router payload IDs and caches
- Support for tracking previous URL state for intercepted App Router entries
- Self-hosted Google Font assets now emit proper served URLs

### Bug Fixes

- Fixed race condition in navigation by tracking pending pathname to resolve `isSameRoute` issues during rapid navigation
- Preserved intercepted app-router state across server actions
- Fixed console output preservation for caught app errors in development
- Corrected handling of React hooks used without proper directives, now returns appropriate errors
- Fixed import issues with local navigation module in error boundaries
- Resolved stale parallel slots clearing on traversal in `mergeElements`
- Fixed cached headers/cookies snapshot invalidation in `applyMiddlewareRequestHeaders`
- Middleware request-header overrides now properly applied before App->Pages fallback and to App Route request objects
- Stripped internal prerender auth header from external rewrites for security
- Parallel slot persistence and cache variants now working correctly
- Fixed `searchParams` passing to layout `generateMetadata` function
- Resolved Windows backslash normalization in CSS URL paths
- Fixed CSRF origin wildcard patterns to use segment-based domain matching
- Excluded `@tailwindcss/oxide` from dependency optimization to prevent build issues
- Improved `runWith*` return type narrowing when callback is async

### Internal / Chores

- Extracted various internal components to separate files for better code organization
- Removed internal re-exports from entry points
- Removed 'use server' collision workaround plugin (no longer needed)
- Classification reasons sidecar now behind `VINEXT_DEBUG_CLASSIFICATION` flag
- Centralized request-derived page inputs in app-rsc-entry
- Updated documentation to remove stale information about layout segments

### Contributors

@fengmk2
@NathanDrake2406
@lyzno1
@james-elicx
@467469274
@hyoban
@erezrokah
@Divkix
@Shorebirdmgmt
@southpolesteve

## 0.0.41

### New Features

- Added Content Security Policy (CSP) support for enhanced security

### Bug Fixes

- Fixed font call range tracking during plugin transformations
- Fixed RequestCookies validation to prevent invalid Cookie header mutations
- Fixed URL scheme detection to properly handle control characters
- Fixed app router to reject cyclic Flight payloads in server actions, preventing infinite loops
- Fixed middleware header merging to use proper override semantics in app routes
- Fixed parallel slot parameter handling to correctly apply override params to segment maps
- Fixed middleware header merging for HTML responses to use override semantics
- Silenced unnecessary IMPORT_IS_UNDEFINED warnings for proxy.ts files

### Internal / Chores

- Updated @clerk/nextjs compatibility status from unsupported to partial
- Rebuilt lockfile for dependency consistency

### Contributors

@hyoban
@james-elicx
@Divkix
@Shorebirdmgmt
@southpolesteve
@NathanDrake2406

## 0.0.40

### New Features

- Add client primitives for layout persistence (Slot, Children, mergeElementsPromise) to improve navigation experience

### Bug Fixes

- Fix URL/content mismatch during rapid Pages Router navigation
- Fix NotFoundBoundary positioning by moving it inside Template in per-segment wiring
- Fix template and layout interleaving at each segment level
- Fix URL parameter extraction for intercepting route source routes
- Fix parallel route segment population in LayoutSegmentProvider
- Fix Cache-Control header to emit no-store for pages with revalidate = 0
- Fix redirect() to default to "push" behavior in Server Action context
- Fix server action re-render path by awaiting buildPageElement
- Fix public file serving in production builds
- Fix ResponseCookies to deduplicate Set-Cookie headers and add missing API surface
- Fix middleware header application to intercept route and server action responses
- Fix thenable params and searchParams handling in probePage()
- Fix request context cleanup on stream errors in deferUntilStreamConsumed
- Fix redirect status code validation in NextResponse.redirect()
- Fix multi-valued Set-Cookie header preservation in route handler ISR cache
- Fix standalone dependency resolution issues
- Fix Vite 8 treeshake.preset warning during build

### Internal / Chores

- Extract route wiring from generated entry into typed runtime module
- Remove unused rsc-html-stream dependency
- Address security audit findings
- Bump vulnerable dependencies

### Contributors

@NathanDrake2406
@Debbl
@james-elicx
@hyoban
@Divkix

## 0.0.39

### New Features

- Added standalone self-host output option with aligned production initialization scripts
- Implemented `parallelRoutesKey` support in `useSelectedLayoutSegment` and `useSelectedLayoutSegments` hooks

### Bug Fixes

- Fixed cross-route client navigation hanging issues in Firefox
- Resolved KV cache key format mismatch between build-time and runtime for static serving
- Fixed font self-hosting transform to properly handle nested-brace options objects
- Fixed double-comma syntax errors when font options contain trailing commas
- Fixed route segment revalidation mapping to Nitro routeRules SWR
- Prevented parse errors by skipping MDX files during RSC scan-build process

### Performance

- Added build-time precompression and startup metadata cache for static file serving
- Optimized `resolveParentParams` lookups for better routing performance

### Internal / Chores

- Improved SSR head management and validation
- Enhanced code quality with additional lint rules including preferring `type` over `interface` and disabling explicit `any`
- Added shared test helpers and modern JavaScript syntax improvements
- Enabled pnpm supply chain security rules
- Added comprehensive test running scripts for unit and integration tests
- Expanded gitignore entries for better repository hygiene

### Contributors

@Divkix
@NathanDrake2406
@james-elicx
@sankalpmukim
@ygcaicn

## 0.0.38

### New Features

- Add instrumentation-client support for enhanced application monitoring
- Implement `cacheForRequest()` per-request factory cache for improved data caching patterns

### Bug Fixes

- Fix Pages Router builds to properly run the Cloudflare plugin during build process
- Wire `ctx.waitUntil` for middleware fetch event background tasks in Cloudflare Workers
- Fix Google Fonts plugin state management by using closure variables instead of class properties
- Improve RSC compatibility for `dynamic()` imports and layout segment context
- Resolve App Router playground warnings and stabilize development checks

### Internal / Chores

- Extract image utility functions into dedicated module for better code organization
- Refactor OG asset handling into separate plugin file
- Refactor font processing into dedicated plugin module
- Extract server closure collision fix into standalone plugin
- Consolidate file path resolution logic into unified `resolveEntryPath()` function
- Extract Pages API route runtime for better separation of concerns
- Align Vite 8 bundler configuration
- Add static export end-to-end tests

### Contributors

@james-elicx
@nbardy
@hyoban
@MehediH
@benfavre
@southpolesteve
@haddoumounir
@raed04
@JamesbbBriz

## 0.0.37

### Bug Fixes

- Fixed hydration timing issue where `createFromReadableStream` was incorrectly awaited before calling `hydrateRoot`, which could cause React hydration problems
- Fixed pathname decoding in App Router to Pages Router fallback to properly handle URL segments with encoded characters

### Internal / Chores

- Updated benchmarks to remove Vite 7 runner and upgrade Next.js to version 16.2.1

### Contributors

@southpolesteve

## 0.0.36

### New Features

- Added nextjs-tracker workflow to automatically monitor and track changes in Next.js canary releases

### Bug Fixes

- Fixed `usePathname()` returning "/" during server-side rendering of "use client" page components
- Fixed anchor condition value regex to properly match full strings in routing logic

### Internal / Chores

- Improved nextjs-tracker agent performance by preventing unnecessary codebase exploration
- Enhanced nextjs-tracker workflow reliability with better repository parameter handling
- Refactored Pages runtime to extract page data and ISR functionality into separate modules

### Contributors

@southpolesteve
@Divkix

## 0.0.35

### New Features

- Added support for inline Next.js configuration instead of requiring separate config files
- Enhanced optimize-imports feature to support renamed exports for better import optimization
- Memory cache can now be pre-populated from pre-rendered routes for improved performance

### Bug Fixes

- Fixed handling of non-ASCII characters in route parameters by properly percent-encoding X-Vinext-Params header
- Resolved Node.js compatibility issues with WASM imports in og-font-patch by using dynamic imports
- Fixed timing issue where request context was cleared before HTML streams were fully consumed
- Prevented DOM pollution by stripping priority prop before forwarding to UnpicImage component

### Internal / Chores

- Moved pnpm configuration settings to pnpm-workspace.yaml for better workspace management
- Refactored pages response helpers into separate utilities for improved code organization

### Contributors

@southpolesteve
@hyoban
@NathanDrake2406
@james-elicx

## 0.0.34

### New Features

- Google Fonts are now handled through virtual import rewrites instead of a generated catalog, improving build performance and flexibility

### Bug Fixes

- Fixed TypeScript alias transforms not working correctly in React Server Components builds
- Fixed `useActionState` state becoming undefined when `redirect()` is called during form actions
- Fixed Server-Side Rendering streaming issues in Pages Router applications
- Fixed flight hint regex not matching the correct format for hydration layer hints

### Internal / Chores

- Extracted app page render lifecycle into separate modules for better code organization
- Refactored app page boundary rendering, HTML recovery, and probe runtimes into dedicated modules
- Separated app page boundary helpers, request helpers, and stream helpers into individual utilities
- Improved app page execution helpers organization
- Added documentation for generated entry refactor guidance

### Contributors

@southpolesteve
@yunus25jmi1
@JaredStowell
@james-elicx

## 0.0.33

### New Features

- Optimize barrel imports for RSC-incompatible packages to improve performance and compatibility

### Bug Fixes

- Skip page RSC ISR caching for dynamic requests to prevent incorrect cache behavior

### Performance

- Improved App Router runtime performance through code restructuring and optimization

### Internal / Chores

- Refactored App Router virtual entries into typed runtime modules for better maintainability
- Extracted app page and route handler logic into dedicated helper modules
- Updated nitro dependency to address h3 security vulnerability
- Upgraded vitest to v4 with agent reporter enabled

### Contributors

@southpolesteve
@gentritbiba
@james-elicx

## 0.0.32

### New Features

- Added support for `next/dist/*` internal imports with automatic .js shim aliases generation
- Full `next/compat/router` support is now available
- The `vinext check` command now flags usage of `__dirname` and `__filename` and suggests ESM path APIs instead
- Added `basePath` and `locale` properties to `NextURL` for better compatibility

### Bug Fixes

- Fixed serving of public directory files after middleware execution in production builds
- Page extensions are now properly used for middleware files
- Fixed `getStaticProps` revalidate parsing to be scoped only to the exported function
- Improved `next/head` SSR serializer to validate attribute names
- `Set-Cookie` headers are now properly stripped from fetch cache entries
- Next.js config file loading now throws errors when it fails instead of failing silently
- Fixed `pageExtensions` handling in prerender and excluded underscore-prefixed API files
- Enhanced `vinext check` scanner to work correctly with shimmed modules

### Internal / Chores

- Switched back to `setup-vp@v1` for CI
- Migrated `ssrLoadModule` to use `moduleRunner.import`
- Marked `clientReferenceDedup` as experimental and added fumadocs example

### Contributors

@southpolesteve
@james-elicx
@Boyeep
@hyoban
@NathanDrake2406

## 0.0.31

### New Features

- Added support for `@vitejs/plugin-react` v6 as a peer dependency
- Implemented production prerender pipeline for static site generation
- Added ISR caching support for App Router route handlers
- Implemented prefix-based cache invalidation for `revalidatePath` with layout type
- Added `revalidateByPathPrefix` support to KVCacheHandler
- Propagated Next.js config `serverExternalPackages` to build configuration

### Bug Fixes

- Fixed Flight HL stylesheet hints rewriting during client-side navigation
- Hardened origin validation and proxy request handling for improved security
- Fixed `next/headers` cookie path semantics to align with Next.js behavior
- Preserved named capture groups in Next.js config destinations
- Fixed `after()` function to use `waitUntil` properly in Cloudflare Workers
- Eliminated double middleware execution in hybrid app+pages development mode
- Added missing `ResponseCookies.has()` method implementation
- Fixed `use server` closure variable collision with local declarations
- Resolved concurrent SSR isolation issues for pages router head/router state
- Fixed parallel slot resolution to use closest ancestor instead of farthest
- Prevented user searchParams from leaking into ISR cache
- Fixed SSR preloading of client reference modules before first render
- Merged top-level optimizeDeps with per-environment Vite configuration
- Added `assets.directory` to generated `wrangler.jsonc` configuration
- Added support for `@voidzero-dev/vite-plus-core` as Vite alias

### Internal / Chores

- Migrated build system to Vite Plus
- Moved to pnpm catalogs for dependency management
- Migrated from Wrangler `unstable_dev` to `unstable_startWorker` API
- Enabled TypeScript type-aware checking and validation
- Updated benchmarks to include `@vitejs/plugin-react`

### Contributors

@aidantrabs
@gagipro
@hyoban
@james-elicx
@Jbithell
@mhart
@NathanDrake2406
@southpolesteve

## 0.0.30

### New Features

- Added Pages Router i18n domain routing support

### Bug Fixes

- Fixed `next/head` key deduplication to properly handle duplicate meta tags
- Fixed image optimizer fallback stream reuse issues
- Fixed metadata routes not serving properly in dynamic segments
- Fixed URL object handling in metadata `resolveUrl` function
- Fixed XML special character escaping in sitemap generation
- Fixed query parameter preservation on middleware rewrites in App Router
- Fixed stale background refetch deduplication in fetch cache
- Fixed `MemoryCacheHandler` creating immediately-stale entries when `revalidate: 0` is used
- Fixed `useSelectedLayoutSegment` hook in development mode
- Fixed intercept routes (..) to climb visible route segments instead of filesystem directories
- Fixed `onLoadingComplete` callback support in modern `next/image` shim
- Fixed parsing of `:param(constraint)` syntax in middleware matchers
- Fixed router events `hashChangeStart`, `hashChangeComplete`, and `beforeHistoryChange` emission
- Fixed route handler `Allow` header and default export behavior to align with Next.js
- Fixed missing methods (`set`, `delete`, `clear`, `size`, `toString`) in `RequestCookies`
- Fixed middleware `waitUntil` propagation to Workers execution context
- Fixed per-request i18n locale state using `AsyncLocalStorage`
- Updated import checks to support `next/{mod}.js` file extensions
- Added missing `.js` alias variants for `next/config` and `next/amp`
- Improved metadata scanning to ignore `@slot` and `_private` directories

### Performance

- Unified per-request AsyncLocalStorage into shared request context
- Shared ISR deduplication maps across RSC/SSR environments using `Symbol.for()`

### Internal / Chores

- Upgraded Vitest to v4.1
- Eliminated `as any` and `as unknown as` type assertions
- Added missing `__vinext` globals to `global.d.ts` and removed unsafe casts
- Excluded benchmarks/nextjs from pnpm workspace to prevent dependency hoisting
- Updated Vite beta usage to v8

### Contributors

@benfavre
@Dayifour
@Divkix
@hyoban
@james-elicx
@JaredStowell
@NathanDrake2406

## 0.0.29

### New Features

- Added support for Vite 8's `resolve.tsconfigPaths` option
- Added Next.js-style route report to `vinext build` output, showing discovered routes and their types
- Enhanced metadata support with parity for `appLinks`, `iTunes`, and Twitter player/app cards

### Bug Fixes

- Fixed `useParams()` to be reactive during client-side navigation in App Router
- Fixed Pages Router ISR background regeneration incorrectly re-rendering HTML
- Fixed middleware custom responses corrupting binary bodies in development mode
- Fixed App Router route discovery incorrectly including private folders (those with `_` prefix)
- Fixed `Link` component's `onNavigate` URL resolution for relative hrefs
- Fixed synthetic slot sub-routes being processed without parent default fallback
- Fixed request headers proxy missing iterator method bindings
- Fixed Pages API body parser handling of invalid JSON and repeated form keys
- Fixed App Router route-group and slot collision detection
- Fixed TPR zone resolution for domains with multi-part TLDs (e.g., `.co.uk`)
- Fixed encoded path delimiters being corrupted during route discovery and matching
- Added missing client-side `optimizeDeps` entries for better development experience
- Added `headersSent` guards to prevent duplicate response headers in error handlers
- Improved error reporting by properly registering `reportRequestError` with `ctx.waitUntil` on Cloudflare Workers
- Added Next.js shim JavaScript variants for better compatibility

### Performance

- Replaced O(n) linear route matching with radix trie for faster routing
- Added async I/O and caching for `og-inline-fetch-assets` transform
- Implemented TTL-based eviction sweep for prefetch cache
- Applied various startup and cache micro-optimizations

### Internal / Chores

- Pinned Rollup to patched version addressing CVE-2026-27606
- Added comprehensive tests for `headers()` and `cookies()` in server actions and route handlers
- Added runtime documentation warning on external rewrites and Content-Disposition sanitization

### Contributors

@hyoban
@NathanDrake2406
@JaredStowell
@james-elicx
@Divkix

## 0.0.28

### New Features

- Added ISR (Incremental Static Regeneration) caching support for App Router in production environments with stale-while-revalidate strategy
- Added Node execution context handling for improved compatibility

### Bug Fixes

- Fixed Pages production config headers and redirects handling after middleware rewrites
- Fixed Pages API body parsing and `res.send(Buffer)` behavior to align with Next.js
- Fixed router.pathname to return route pattern instead of resolved path
- Fixed object-form query array serialization in `next/link` and `next/router`
- Fixed router.push/replace to properly honor the `as` parameter
- Fixed Link component to skip locale prefix for absolute and protocol-relative hrefs
- Fixed App Router ISR invalidation to match Next.js behavior for fetch and path tags
- Fixed next/form submitter overrides and query-string GET URLs handling
- Fixed useSearchParams to return ReadonlyURLSearchParams as expected
- Fixed sitemap XML namespaces, video entries, and alternate-language links generation
- Fixed useRouter to honor beforePopState callback when component is mounted
- Fixed route rewrites and redirects to preserve repeated route and query parameters
- Fixed dynamic route discovery to reject conflicting dynamic route siblings
- Fixed Pages Router query arrays and hash preservation in asPath
- Fixed catch-all routes validation to reject non-terminal catch-all routes in both Pages and App routers
- Fixed RSC client references deduplication to prevent module duplication in development
- Fixed next/headers to implement proper readonly semantics and legacy sync compatibility
- Fixed RequestCookie behavior and getAll(name) method implementation
- Fixed middleware object matcher semantics to match Next.js i18n behavior
- Fixed Pages Router production hydration for inlined page modules

### Performance

- Added local tag cache for KV operations to reduce round-trips on cache hits
- Improved fetch cache to register stale-while-revalidate refetch with waitUntil() for better performance
- Fixed ISR cache handler to properly await KV put operations and prevent perpetual STALE status
- Added cache key namespacing by buildId for better ISR cache management

### Internal / Chores

- Refactored ExecutionContext AsyncLocalStorage to be the single source of truth
- Updated ISR implementation to use getRequestExecutionContext() from ALS in background regeneration

### Contributors

@JaredStowell
@NathanDrake2406
@Divkix
@james-elicx

## 0.0.27

### New Features

- Added AsyncLocalStorage support for ExecutionContext (ctx) propagation, enabling better context management across async operations
- Added support for `generateBuildId` in next.config with runtime build ID injection
- Added `generateSitemaps()` support for creating paginated sitemaps

### Bug Fixes

- Fixed handling of single object values for `openGraph.images` and `twitter.images` metadata
- Fixed middleware request header deletions to be properly preserved
- Fixed basePath stripping and redirect prefixing to enforce proper segment boundaries
- Fixed background KV operations and ISR regeneration to register with `ctx.waitUntil` on Cloudflare Workers
- Fixed dynamic GET handlers to avoid shared cache headers
- Fixed dev-mode middleware runner to preserve `x-middleware-request-*` headers
- Moved optional dependencies to peerDependencies to resolve dependency management issues

### Performance

- Improved route matching performance by pre-splitting route patterns and hoisting URL split operations out of match loops
- Added regex caching in middleware matcher for better performance
- Implemented O(1) locale-static redirect indexing
- Added caching for compiled regex patterns in `matchConfigPattern`
- Optimized header handling by lazy-initializing mutable Headers copy in `headersContextFromRequest`

### Internal / Chores

- Added oxfmt formatter for code formatting
- Added automated draft GitHub release creation with AI-generated notes

### Contributors

- @james-elicx
- @NathanDrake2406
- @jokull
- @JaredStowell
- @hyoban
