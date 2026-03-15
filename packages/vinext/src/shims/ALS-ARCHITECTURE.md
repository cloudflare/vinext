# asynclocalstorage architecture

## overview

vinext uses `AsyncLocalStorage` (als) to keep each request's state separate
when multiple requests are being handled at the same time. without it,
things like headers, cookies, `<Head>` children, and cache tags would bleed
between concurrent requests.

## two-tier scope model

### 1. unified request context (per-request)

one `AsyncLocalStorage<UnifiedRequestContext>` holds all per-request state in
a flat object. pr #450 introduced this to replace the 5-6 nested als scopes
that existed before.

**file:** `unified-request-context.ts`

**what it holds:**

- `headersContext` - request/response headers, cookies (`headers.ts`)
- `dynamicUsageDetected`, `phase` - dynamic rendering state (`navigation-state.ts`)
- `pendingSetCookies`, `draftModeCookieHeader` - cookie mutations (`headers.ts`)
- `i18nContext` - locale info (`i18n-state.ts`)
- `serverContext`, `serverInsertedHTMLCallbacks` - rsc server context (`navigation-state.ts`)
- `requestScopedCacheLife` - per-request cache life override (`cache.ts`)
- `_privateCache` - per-request private cache map (`cache-runtime.ts`)
- `currentRequestTags` - revalidation tags (`fetch-cache.ts`)
- `executionContext` - cloudflare workers execution context (`request-context.ts`)
- `ssrContext` - pages router ssr context for `useRouter()` (`router-state.ts`)
- `ssrHeadChildren` - collected `<Head>` children during ssr (`head-state.ts`)

**lifecycle:** created at the start of each request with `createRequestContext()`,
then passed to `runWithRequestContext(ctx, fn)`. everything inside `fn` -
including react rendering - sees the same context through async continuations.

**cross-environment sharing:** the als instance lives on `globalThis` via
`Symbol.for("vinext.unifiedRequestContext.als")` so all vite module environments
(rsc, ssr, client) share the same instance.

### 2. per-call cache scopes

two als instances stay separate from the unified context because they scope to
individual function calls within a request, not the request itself:

**`cacheContextStorage`** (`cache-runtime.ts`)

- wraps each `"use cache"` function call
- collects `cacheTag()` and `cacheLife()` calls made inside that cached function
- a single request can run multiple cached functions, each needing its own
  tag/life collection
- merging this into the unified context would mean managing nested scopes for
  every cached call - the standalone als is simpler and correct

**`_unstableCacheAls`** (`cache.ts`)

- wraps each `unstable_cache()` call with a boolean `true` flag
- lets `headers()`, `cookies()`, and `connection()` detect they're inside a
  cache scope and throw (dynamic apis are not allowed inside cache scopes)
- just a boolean flag, no state to merge

**why they stay separate:** these nest inside a request but bind to individual
cache function calls. a request might run zero, one, or many cached functions
at the same time, each needing isolated tag/life tracking. the unified context
is per-request; these are per-call.

## shim registration pattern

each shim module (e.g. `head-state.ts`, `router-state.ts`) follows this pattern:

1. the base shim (e.g. `head.ts`) has module-level fallback state and a
   registration function like `_registerHeadStateAccessors()`
2. the state module (e.g. `head-state.ts`) imports the unified context and
   registers als-backed accessors that read from the per-request store
3. the state module checks `isInsideUnifiedScope()` to decide whether to read
   from the unified store or fall back to the standalone path

in dev, vite has separate module graphs for different environments (node vs ssr).
the state module must be loaded in each environment that uses it. the dev server
calls `server.ssrLoadModule("vinext/head-state")` to make sure registration
happens in the ssr module graph.

in prod, bundling collapses everything into one module graph, so registration
happens naturally through static imports.

## adding new request-scoped state

1. add the field to `UnifiedRequestContext` in `unified-request-context.ts`
2. add the type to `request-state-types.ts`
3. set a default in `createRequestContext()`
4. in your shim, use `isInsideUnifiedScope()` to read from the unified store,
   falling back to standalone als when outside
5. if the state is accessed by react components during ssr in dev, load the
   state module via `server.ssrLoadModule()` in `dev-server.ts` (node-side-only
   state does not need this)
6. if the state is per-call rather than per-request (like cache scopes), keep
   it in its own als - don't add it to the unified context
