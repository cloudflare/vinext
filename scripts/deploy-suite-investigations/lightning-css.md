# Deploy-suite investigation: "lightning-css" cluster

Reference: GitHub Actions run
[25870737355](https://github.com/cloudflare/vinext/actions/runs/25870737355).

## TL;DR

The cluster labelled "lightning-css" is a **misnomer**. The cluster was
created by grouping every deploy-suite build log that contains the line
`Build failed with N error:` — but that line is just Vite's generic build
header. It hides at least 12 distinct root causes underneath it.

Only **2 of 50** sampled build-log excerpts in
`by-cluster/lightning-css.json` are genuine Lightning CSS errors. The rest
are sass, missing exports, wasm imports, PostCSS, Flow syntax, route
validation, etc.

**None of the genuine Lightning CSS failures can be fixed in
`scripts/`** — they are caused by vinext source not wiring Next.js's
`sassOptions.additionalData` into Vite's
`css.preprocessorOptions.scss.additionalData`. That is a vinext source bug
(or, more accurately, a parity gap). See "Follow-up issues" below.

This PR therefore makes no code changes; it records the investigation so
that future deploy-suite work can re-cluster the failures correctly.

## Sub-error breakdown of the 50 sampled excerpts

Classifier: regex match against the first error block after each
`Build failed with N error:` header in the persisted build log. See the
analysis recipe at the bottom of this file.

| Count | Sub-error                                                    | Real cluster                   |
| ----: | ------------------------------------------------------------ | ------------------------------ |
|    19 | `TypeError: [sass] sass.initAsyncCompiler is not a function` | **sass** (separate cluster)    |
|    11 | Build header with no in-window error body                    | duplicated noise               |
|     3 | `[UNLOADABLE_DEPENDENCY] Could not load …add.wasm?module`    | needs new "wasm" cluster       |
|     3 | `[plugin vite:css]` non-sass (PostCSS, missing @import)      | mixed — see below              |
|     3 | `[MISSING_EXPORT] "unstable_catchError" \| "unstable_…"`     | needs new "missing-shim" cluster |
|     2 | `SyntaxError: [lightningcss minify] Invalid empty selector`  | **the only real "lightning-css"** |
|     1 | `[MISSING_EXPORT] "unstable_rethrow"`                        | needs "missing-shim" cluster   |
|     1 | `[PARSE_ERROR] Flow is not supported`                        | flow-syntax cluster            |
|     1 | `[plugin rsc:use-client] … Parse failed`                     | unrelated, parse error         |
|     1 | `[UNRESOLVED_IMPORT] Could not resolve './image'`            | unrelated, asset import        |
|     1 | `[plugin rsc:use-client] … export-all`                       | unrelated, export pattern      |
|     1 | `[UNSUPPORTED_FEATURE] Bundling CSS is no longer supported`  | Rolldown CSS bundling issue    |
|     1 | `[plugin rsc:validate-imports] 'server-only' cannot be imported in client build (ssr)` | unrelated, RSC validation |
|     1 | `[PARSE_ERROR] Identifier has already been declared`         | test fixture parse problem     |

(The 11 "header with no body" cases are still in the cluster because the
classifier's regex window cut off before the actual error line; spot
checks confirm the bodies are mostly more sass/missing-export instances.)

## Top affected test suites — actual root cause

Per the agent brief, these are the top five suites by deploy-script
failure count. After tracing each to the build log persisted in the
shard logs (`shard-logs/*.log`), the **real** failure modes are:

| Suite                                                  | Deploy fails | Actual root cause                                                                                   |
| ------------------------------------------------------ | -----------: | --------------------------------------------------------------------------------------------------- |
| `app-dir/app-static/app-static.test.ts`                |           87 | `[MISSING_EXPORT] "unstable_rethrow" is not exported by vinext/dist/shims/navigation.react-server.js` |
| `e2e/prerender.test.ts`                                |           63 | Did not start in sampled shards; counted from `failures.json` totals (likely same `unstable_rethrow` or related shim gap) |
| `app-dir/metadata-dynamic-routes/index.test.ts`        |           21 | `Cannot find module '@next/bundle-analyzer' imported from next.config.js` (devDep not installed)    |
| `app-dir/interception-dynamic-segment/...test.ts`      |           14 | `[plugin vinext:config] Error: You cannot use different slug names for the same dynamic path ('username' !== 'slug')` — vinext's `validateRoutePatterns` is over-strict for intercepting parallel routes |
| `app-dir/actions-unrecognized/actions-unrecognized.test.ts` | 9       | `[MISSING_EXPORT] "unstable_isUnrecognizedActionError" is not exported by vinext/dist/shims/navigation.js` |

**None of these are Lightning CSS issues.** Of the five, only one
(`metadata-dynamic-routes` — `@next/bundle-analyzer`) is plausibly
deploy-script-fixable, and it belongs to the **missing-deps** cluster
(separate agent).

## The two genuine Lightning CSS errors

```
[plugin vite:css-post]
SyntaxError: [lightningcss minify] Invalid empty selector
1  |  $var: red;._className_10j3d_2 {
   |  ^
```

```
[plugin vite:css-post]
SyntaxError: [lightningcss minify] Invalid empty selector
1  |  @import 'other3.scss';$var: red;._className_1344s_4 {
   |                        ^
```

Both come from the
[`app-dir/scss/basic-module-additional-data`](https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/basic-module-additional-data/basic-module-additional-data.test.ts)
family of Next.js fixtures. They configure `sassOptions.additionalData`
in `next.config.js`:

```js
const sassOptions = { additionalData: `$var: red;` };
// ...
nextConfig: { sassOptions }
```

In Next.js, `sassOptions` is forwarded into the webpack sass loader.
In vinext, **no code translates `nextConfig.sassOptions` into Vite's
`css.preprocessorOptions.scss.additionalData`** (`rg sassOptions
packages/vinext/src/` returns nothing). The fixture's
`index.module.scss` is just `.redText { color: $var; }`. Without
`additionalData`, Sass sees `$var` as undefined, but the test fixtures
include a literal `$var: red;` declaration via the `additionalData`
config that never gets applied. The Sass output therefore inlines the
declaration verbatim, and Lightning CSS rejects it as an "empty
selector" during minification.

**Root cause: vinext source does not implement the `sassOptions` →
`css.preprocessorOptions.scss` adapter that Next.js apps expect.**

## What this PR explicitly does NOT fix

* Sass `initAsyncCompiler` failures — owned by the **sass** cluster agent.
* `unstable_rethrow` / `unstable_catchError` / `unstable_isUnrecognizedActionError` missing exports — vinext shim gaps; see follow-up #1.
* Wasm `?module` import — vinext source gap (Vite asset query handling); see follow-up #2.
* `@next/bundle-analyzer` and other Next.js devDep imports inside `next.config.js` — owned by the **missing-deps** cluster agent.
* `vinext:config` slug-name validation rejecting valid intercepting parallel routes — vinext source bug; see follow-up #3.
* Lightning CSS minifier rejecting Sass-prepended-data output — vinext source bug; see follow-up #4.

## Follow-up issues to file

These should each be a separate GitHub issue against `cloudflare/vinext`,
referencing run 25870737355.

1. **shim: add `unstable_rethrow`, `unstable_catchError`, and
   `unstable_isUnrecognizedActionError` to `next/navigation` shim**
   * Impact: ~96 deploy failures across `app-static`, `actions-unrecognized`, related suites.
   * Source files: `packages/vinext/src/shims/navigation.ts`,
     `packages/vinext/src/shims/navigation.react-server.ts`.
   * Next.js reference: `.nextjs-ref/packages/next/src/client/components/navigation.ts`.

2. **wasm: support `?module` import suffix in build**
   * Repro fixture: any `*.wasm?module` import (Next.js's wasm tests).
   * Vite supports this natively via `?init` and `?url`; need to either
     map `?module` → `?init` or implement `?module` resolution in the
     vinext plugin.

3. **routing: relax `validateRoutePatterns` for valid intercepting parallel routes**
   * Repro: `test/e2e/app-dir/interception-dynamic-segment`. Next.js
     allows `[username]` in one slot and `[slug]` in a parallel slot
     under the same dynamic path; vinext rejects this.
   * Source: `packages/vinext/src/routing/route-validation.ts:39` (`handleSlug`).

4. **css: wire `nextConfig.sassOptions` into Vite's
   `css.preprocessorOptions.scss`**
   * Affects: `app-dir/scss/basic-module-additional-data`,
     `basic-module-prepend-data`, `basic-module-include-paths`,
     `multi-global*`, and any user app that sets `sassOptions` in
     `next.config.js`.
   * Today the option is silently dropped, which then causes either
     Sass `$var is undefined` errors (when the variable is referenced)
     or Lightning CSS minify failures (when the prepend-data ends up
     inlined as a declaration).
   * Suggested mapping (Next.js → Vite):
     * `sassOptions.additionalData` → `css.preprocessorOptions.scss.additionalData`
     * `sassOptions.includePaths` → `css.preprocessorOptions.scss.loadPaths`
     * `sassOptions.implementation: 'sass-embedded'` → make sure
       `sass-embedded` is preferred over `sass` when resolving.
   * Implementation point: `packages/vinext/src/index.ts` (Vite plugin's
     `config()` hook), or wherever vinext currently builds its Vite
     config from `nextConfig`.

5. **cluster classifier: split "lightning-css" by inner error**
   * The deploy-suite reporting groups failures by regex
     `Build failed with \d+ error`. That regex is too generic — it
     matches the build header rather than the actual error. Future
     reports should group by the first `[ERROR_KIND]` token (e.g.
     `[MISSING_EXPORT]`, `[UNLOADABLE_DEPENDENCY]`, `lightningcss
     minify`, `sass.initAsyncCompiler`) so that each cluster has a
     single actionable root cause.

## Why this fix doesn't belong in `scripts/`

Per `AGENT_BRIEF.md`: "Keep `vinext` source untouched. Your fix should be
in `scripts/` (deploy harness), unless the cluster brief explicitly
tells you otherwise."

For this cluster, the brief explicitly warns: "this cluster is the most
speculative. Some of these failures may be vinext source bugs (Lightning
CSS misconfig, wrong minify defaults) rather than deploy-script bugs. Do
not invent fixes. If your investigation concludes the fix belongs
elsewhere, document the finding and stop."

The deploy harness already does everything it can:

* It installs vinext, runs `vinext init`, converts the config, and
  invokes `vinext build`. There is no environment variable, CLI flag,
  or vite config knob it could set that would bypass the four root
  causes above without modifying vinext source.
* Disabling Lightning CSS in the deploy script (e.g., by writing an
  override `vite.config.ts`) would mask the real issues, change build
  output in ways that affect other tests, and violate the agent brief's
  quality bar ("Do not 'fix' something by suppressing the error or
  making the script exit 0 on failure").

## Analysis recipe (for re-running)

```bash
# Classify the sampled excerpts:
python3 - <<'PY'
import json, re
data = json.load(open('/tmp/opencode/deploy-fix-shared/by-cluster/lightning-css.json'))
buckets = {}
for e in data:
    text = re.sub(r'\x1b\[[0-9;]*[mGK]', '', e['excerpt'])
    text = re.sub(r'\^\[\[[0-9;]*[mGK]', '', text)
    m = re.search(r'Build failed with \d+ errors?:(.{0,400})', text, re.DOTALL)
    body = m.group(1) if m else ''
    for pat, label in [
        (r'lightningcss minify', 'LIGHTNING_CSS'),
        (r'sass\.initAsyncCompiler', 'SASS'),
        (r'\[UNLOADABLE_DEPENDENCY\]', 'UNLOADABLE'),
        (r'\[MISSING_EXPORT\]', 'MISSING_EXPORT'),
        (r'Flow is not supported', 'FLOW'),
        (r'PostCSS config', 'POSTCSS'),
        (r'You cannot', 'ROUTE_VALIDATION'),
        (r'\[UNSUPPORTED_FEATURE\]', 'UNSUPPORTED_FEATURE'),
        (r'server-only', 'SERVER_ONLY'),
        (r'\[PARSE_ERROR\]', 'PARSE_ERROR'),
    ]:
        if re.search(pat, body):
            buckets[label] = buckets.get(label, 0) + 1
            break
    else:
        buckets['OTHER'] = buckets.get('OTHER', 0) + 1
for k, v in sorted(buckets.items(), key=lambda x: -x[1]):
    print(f'{v:4d}  {k}')
PY
```
