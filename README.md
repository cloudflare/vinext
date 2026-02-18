# vinext

The Next.js API surface, reimplemented on Vite.

> 🚧 **Experimental — under heavy development.** This project is an experiment in AI-driven software development. The vast majority of the code, tests, and documentation were written by AI (Claude Code). Humans direct architecture, priorities, and design decisions, but have not reviewed most of the code line-by-line. Treat this accordingly — there will be bugs, rough edges, and things that don't work. Use at your own risk.

## Quick start

```bash
npm install vinext
```

Replace `next` with `vinext` in your scripts:

```json
{
  "scripts": {
    "dev": "vinext dev",
    "build": "vinext build",
    "start": "vinext start"
  }
}
```

```bash
vinext dev          # Development server with HMR
vinext build        # Production build
vinext deploy       # Build and deploy to Cloudflare Workers
```

vinext auto-detects your `app/` or `pages/` directory, loads `next.config.js`, and configures Vite automatically. No `vite.config.ts` required for basic usage.

Your existing `pages/`, `app/`, `next.config.js`, and `public/` directories work as-is. Run `vinext check` first to scan for known compatibility issues.

### CLI reference

| Command | Description |
|---------|-------------|
| `vinext dev` | Start dev server with HMR |
| `vinext build` | Production build (multi-environment for App Router: RSC + SSR + client) |
| `vinext start` | Start local production server for testing |
| `vinext deploy` | Build and deploy to Cloudflare Workers |
| `vinext check` | Scan your Next.js app for compatibility issues before migrating |
| `vinext lint` | Delegate to eslint or oxlint |

Options: `-p / --port <port>`, `-H / --hostname <host>`, `--turbopack` (accepted, no-op).

`vinext deploy` options: `--preview`, `--name <name>`, `--skip-build`, `--dry-run`.

## Why

Vite has become the default build tool for modern web frameworks — fast HMR, a clean plugin API, native ESM, and a growing ecosystem. With [`@vitejs/plugin-rsc`](https://github.com/vitejs/vite-plugin-rsc) adding React Server Components support, it's now possible to build a full RSC framework on Vite.

vinext is an experiment: can we reimplement the Next.js API surface on Vite, so that existing Next.js applications can run on a completely different toolchain? The answer, so far, is mostly yes — about 94% of the API surface works.

The current deployment target is Cloudflare Workers — zero cold starts, global by default, integrated platform (KV, R2, D1, AI). The `vinext deploy` command handles the full build-and-deploy pipeline. Expanding to other deployment targets is something we'd like to explore.

**Alternatives worth knowing about:**
- **[OpenNext](https://opennext.js.org/)** — adapts `next build` output for AWS, Cloudflare, and other platforms. More mature and battle-tested than vinext.
- **[Next.js self-hosting](https://nextjs.org/docs/app/building-your-application/deploying#self-hosting)** — Next.js can be deployed to any Node.js server, Docker container, or as a static export.

### Design principles

- **Start with Cloudflare, expand later.** Workers is the current deployment target. Every feature is built and tested for Workers. We're interested in supporting other platforms and welcome contributions.
- **Pragmatic compatibility, not bug-for-bug parity.** Targets 95%+ of real-world Next.js apps. Edge cases that depend on undocumented Vercel behavior are intentionally not supported.
- **Latest Next.js only.** Targets Next.js 16.x. No support for deprecated APIs from older versions.
- **Incremental adoption.** Drop in the plugin, fix what breaks, deploy.

## FAQ

**What is this?**
vinext is a Vite plugin that reimplements the public Next.js API — routing, server rendering, `next/*` module imports, the CLI — so you can run Next.js applications on Vite instead of the Next.js compiler toolchain. Cloudflare Workers is the current deployment target.

**Is this a fork of Next.js?**
No. vinext is an alternative implementation of the Next.js API surface built on Vite. It does import some Next.js types and utilities, but the core is written from scratch. The goal is not to create a competing framework or add features beyond what Next.js offers — it's an experiment in how far AI-driven development and Vite's toolchain can go in replicating an existing, well-defined API surface.

**How is this different from OpenNext?**
[OpenNext](https://opennext.js.org/) adapts the *output* of a standard `next build` to run on various platforms. vinext replaces the build entirely — it reimplements the Next.js APIs on Vite from scratch. OpenNext is a great choice if you need production-ready Next.js on non-Vercel platforms today.

**Can I use this in production?**
You can, with caution. This is experimental software with known bugs. It works well enough for demos and exploration, but it hasn't been battle-tested with real production traffic.

**Can I just self-host Next.js?**
Yes. Next.js supports [self-hosting](https://nextjs.org/docs/app/building-your-application/deploying#self-hosting) on Node.js servers, Docker containers, and static exports. If you're happy with the Next.js toolchain and just want to run it somewhere other than Vercel, self-hosting is the simplest path.

**How are you verifying this works?**
The test suite has over 1,000 Vitest tests and 278 Playwright E2E tests. This includes tests ported directly from the [Next.js test suite](https://github.com/vercel/next.js/tree/canary/test) and [OpenNext's Cloudflare conformance suite](https://github.com/opennextjs/opennextjs-cloudflare), covering routing, SSR, RSC, server actions, caching, metadata, middleware, streaming, and more. Vercel's [App Router Playground](https://github.com/vercel/next-app-router-playground) also runs on vinext as an integration test. See the [Tests](#tests) section and `tests/nextjs-compat/TRACKING.md` for details.

**Who is reviewing this code?**
Mostly nobody. This is an experiment in seeing how far AI-driven development can go. The test suite is the primary quality gate — not human code review. Contributions and code review are welcome.

**Why Vite?**
Vite is an excellent build tool with a rich plugin ecosystem, first-class ESM support, and fast HMR. The [`@vitejs/plugin-rsc`](https://github.com/vitejs/vite-plugin-rsc) plugin adds React Server Components support with multi-environment builds. This project is an experiment to see how much of the Next.js developer experience can be replicated on top of Vite's infrastructure.

**Does this support the Pages Router, App Router, or both?**
Both. File-system routing, SSR, client hydration, and deployment to Cloudflare Workers work for both routers.

**What version of Next.js does this target?**
Next.js 16.x. No support for deprecated APIs from older versions.

**Can I deploy to AWS/Netlify/other platforms?**
Currently only Cloudflare Workers is supported and tested. We're interested in exploring other deployment targets in the future and welcome contributions in that direction.

**What happens when Next.js releases a new feature?**
We track the public Next.js API surface and add support for new stable features. Experimental or unstable Next.js features are lower priority. The plan is to add commit-level tracking of the Next.js repo so we can stay current as new versions are released.

## Deploying to Cloudflare Workers

`vinext deploy` is the simplest path. It auto-generates the necessary configuration files (`vite.config.ts`, `wrangler.jsonc`, `worker/index.ts`) if they don't exist, builds the application, and deploys to Workers.

```bash
vinext deploy
```

The deploy command also auto-detects and fixes common migration issues:
- Adds `"type": "module"` to package.json if missing
- Detects tsconfig.json path aliases and maps them to Vite `resolve.alias`
- Detects MDX usage and configures `@mdx-js/rollup`
- Renames CJS config files (postcss.config.js, etc.) to `.cjs` when needed
- Detects native Node.js modules (sharp, resvg, satori) and stubs them for Workers

Both App Router and Pages Router work on Workers with full client-side hydration — interactive components, client-side navigation, and React state all work.

For production caching (ISR), use the built-in Cloudflare KV cache handler:

```ts
import { KVCacheHandler } from "vinext/cloudflare";
import { setCacheHandler } from "next/cache";

setCacheHandler(new KVCacheHandler(env.MY_KV_NAMESPACE));
```

### Custom Vite configuration

If you need to customize the Vite config, create a `vite.config.ts`. vinext will merge its config with yours. This is required for Cloudflare Workers deployment with the App Router (RSC needs explicit plugin configuration):

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
    }),
    cloudflare({
      viteEnvironment: { childEnvironments: ["rsc", "ssr"] },
    }),
  ],
});
```

See the [examples](#live-examples) for complete working configurations.

## Live examples

These are deployed to Cloudflare Workers and updated on every push to `main`:

| Example | Description | URL |
|---------|-------------|-----|
| App Router Playground | [Vercel's Next.js App Router Playground](https://github.com/vercel/next-app-router-playground) running on vinext | [app-router-playground.vinext.workers.dev](https://app-router-playground.vinext.workers.dev) |
| App Router (minimal) | Minimal App Router on Workers | [cloudflare-app.vinext.workers.dev](https://cloudflare-app.vinext.workers.dev) |
| Pages Router (minimal) | Minimal Pages Router on Workers | [cloudflare-pages.vinext.workers.dev](https://cloudflare-pages.vinext.workers.dev) |
| RealWorld API | REST API routes example | [realworld-api-rest.vinext.workers.dev](https://realworld-api-rest.vinext.workers.dev) |
| Benchmarks Dashboard | Build performance tracking over time (D1-backed) | [benchmarks.vinext.workers.dev](https://benchmarks.vinext.workers.dev) |

## API coverage

~94% of the Next.js 16 API surface has full or partial support. The remaining gaps are intentional stubs for deprecated features and Partial Prerendering (which Next.js 16 reworked into `"use cache"` — that directive is fully supported).

> ✅ = full implementation | 🟡 = partial (runtime behavior correct, some build-time optimizations missing) | ⬜ = intentional stub/no-op

### Module shims

Every `next/*` import is shimmed to a Vite-compatible implementation.

| Module | | Notes |
|--------|---|-------|
| `next/link` | ✅ | All props including `prefetch` (IntersectionObserver), `onNavigate`, scroll restoration, `basePath`, `locale` |
| `next/image` | 🟡 | Remote images via [@unpic/react](https://unpic.pics) (28 CDNs). Local images via `<img>` + srcSet. No build-time optimization/resizing |
| `next/head` | ✅ | SSR collection + client-side DOM manipulation |
| `next/router` | ✅ | `useRouter`, `Router` singleton, events, client-side navigation, SSR context, i18n |
| `next/navigation` | ✅ | `usePathname`, `useSearchParams`, `useParams`, `useRouter`, `redirect`, `notFound`, `forbidden`, `unauthorized` |
| `next/server` | ✅ | `NextRequest`, `NextResponse`, `NextURL`, cookies, `userAgent`, `after`, `connection`, `URLPattern` |
| `next/headers` | ✅ | Async `headers()`, `cookies()`, `draftMode()` |
| `next/dynamic` | ✅ | `ssr: true`, `ssr: false`, `loading` component |
| `next/script` | ✅ | All 4 strategies (`beforeInteractive`, `afterInteractive`, `lazyOnload`, `worker`) |
| `next/font/google` | 🟡 | Runtime CDN loading. No self-hosting, font subsetting, or fallback metrics |
| `next/font/local` | 🟡 | Runtime `@font-face` injection. Not extracted at build time |
| `next/og` | ✅ | OG image generation via `@vercel/og` (Satori + resvg) |
| `next/cache` | ✅ | `revalidateTag`, `revalidatePath`, `unstable_cache`, pluggable `CacheHandler`, `"use cache"` with `cacheLife()` and `cacheTag()` |
| `next/form` | ✅ | GET form interception + POST server action delegation |
| `next/legacy/image` | ✅ | Translates legacy props to modern Image |
| `next/error` | ✅ | Default error page component |
| `next/config` | ✅ | `getConfig` / `setConfig` |
| `next/document` | ✅ | `Html`, `Head`, `Main`, `NextScript` |
| `next/constants` | ✅ | All phase constants |
| `next/amp` | ⬜ | No-op (AMP is deprecated) |
| `next/web-vitals` | ⬜ | No-op (use the `web-vitals` library directly) |

### Routing

| Feature | | Notes |
|---------|---|-------|
| File-system routing (`pages/`) | ✅ | Automatic scanning with hot-reload on file changes |
| File-system routing (`app/`) | ✅ | Pages, routes, layouts, templates, loading, error, not-found, forbidden, unauthorized |
| Dynamic routes `[param]` | ✅ | Both routers |
| Catch-all `[...slug]` | ✅ | Both routers |
| Optional catch-all `[[...slug]]` | ✅ | Both routers |
| Route groups `(group)` | ✅ | URL-transparent, layouts still apply |
| Parallel routes `@slot` | ✅ | Discovery, layout props, `default.tsx`, inherited slots |
| Intercepting routes | ✅ | `(.)`, `(..)`, `(..)(..)`, `(...)` conventions |
| Route handlers (`route.ts`) | ✅ | Named HTTP methods, auto OPTIONS/HEAD, cookie attachment |
| Middleware | ✅ | `middleware.ts` and `proxy.ts` (Next.js 16). Matcher patterns (string, array, regex, `:param`, `:path*`, `:path+`) |
| i18n routing | 🟡 | Pages Router locale prefix, Accept-Language detection, NEXT_LOCALE cookie. No domain-based routing |
| `basePath` | ✅ | Applied everywhere — URLs, Link, Router, navigation hooks |
| `trailingSlash` | ✅ | 308 redirects to canonical form |

### Server features

| Feature | | Notes |
|---------|---|-------|
| SSR (Pages Router) | ✅ | Streaming, `_app`/`_document`, `__NEXT_DATA__`, hydration |
| SSR (App Router) | ✅ | RSC pipeline, nested layouts, streaming, nav context for client components |
| `getStaticProps` | ✅ | Props, redirect, notFound, revalidate |
| `getStaticPaths` | ✅ | `fallback: false`, `true`, `"blocking"` |
| `getServerSideProps` | ✅ | Full context including locale |
| ISR | ✅ | Stale-while-revalidate, pluggable `CacheHandler`, background regeneration |
| Server Actions (`"use server"`) | ✅ | Action execution, FormData, re-render after mutation, `redirect()` in actions |
| React Server Components | ✅ | Via `@vitejs/plugin-rsc`. `"use client"` boundaries work correctly |
| Streaming SSR | ✅ | Both routers |
| Metadata API | ✅ | `metadata`, `generateMetadata`, `viewport`, `generateViewport`, title templates |
| `generateStaticParams` | ✅ | With `dynamicParams` enforcement |
| Metadata file routes | ✅ | sitemap.xml, robots.txt, manifest, favicon, OG images (static + dynamic) |
| Static export (`output: 'export'`) | ✅ | Generates static HTML/JSON for all routes |
| `connection()` | ✅ | Forces dynamic rendering |
| `"use cache"` directive | ✅ | File-level and function-level. `cacheLife()` profiles, `cacheTag()`, stale-while-revalidate |
| `instrumentation.ts` | ✅ | `register()` and `onRequestError()` callbacks |
| Route segment config | 🟡 | `revalidate`, `dynamic`, `dynamicParams`. `runtime` and `preferredRegion` are ignored |

### Configuration

| Feature | | Notes |
|---------|---|-------|
| `next.config.js` / `.ts` / `.mjs` | ✅ | Function configs, phase argument |
| `rewrites` / `redirects` / `headers` | ✅ | All phases, param interpolation |
| Environment variables (`NEXT_PUBLIC_*`) | ✅ | Inlined at build time via Vite |
| `images` config | 🟡 | Parsed but not used for optimization |

### Caching

The cache is pluggable. The default `MemoryCacheHandler` works out of the box. Swap in your own backend for production:

```ts
import { setCacheHandler } from "next/cache";
setCacheHandler(new MyCacheHandler()); // Redis, DynamoDB, etc.
```

The `CacheHandler` interface matches Next.js 16's shape, so community adapters should be compatible.

## What's NOT supported (and won't be)

These are intentional exclusions:

- **Vercel-specific features** — `@vercel/og` edge runtime, Vercel Analytics integration, Vercel KV/Blob/Postgres bindings. Use platform equivalents.
- **AMP** — Deprecated since Next.js 13. `useAmp()` returns `false`.
- **`next export` (legacy)** — Use `output: 'export'` in config instead.
- **Turbopack/webpack configuration** — This runs on Vite. Use Vite plugins instead of webpack loaders/plugins.
- **`next/jest`** — Use Vitest.
- **`create-next-app` scaffolding** — Not a goal.
- **Bug-for-bug parity with undocumented behavior** — If it's not in the Next.js docs, we probably don't replicate it.

## Known limitations

- **Image optimization doesn't happen at build time.** Remote images work via `@unpic/react` (auto-detects 28 CDN providers). Local images are served as-is without resizing or format conversion.
- **Google Fonts are loaded from the CDN, not self-hosted.** No `size-adjust` fallback font metrics. Local fonts work but `@font-face` CSS is injected at runtime, not extracted at build time.
- **`useSelectedLayoutSegment(s)`** derives segments from the pathname rather than being truly layout-aware. May differ from Next.js in edge cases with parallel routes.
- **Route segment config** — `runtime` and `preferredRegion` are ignored (everything runs in the same environment).
- **Node.js production server (`vinext start`)** works for testing but is less complete than Workers deployment. Cloudflare Workers is the primary target.
- **Native Node modules (sharp, resvg, satori)** crash Vite's RSC dev environment. Dynamic OG image/icon routes using these work in production builds but not in dev mode.

## Benchmarks

> **Caveat:** Benchmarks are hard to get right and these are early results. The comparison setup is simple — a shared 33-route App Router app built by both tools. We plan to improve methodology over time, and we expect these numbers to change. Take them as directional, not definitive.

Measured on an 8-core Apple Silicon machine, Node v24.3.0. 3 runs each.

### Production build time

| Framework | Mean | vs Next.js |
|-----------|------|------------|
| Next.js 16 (Turbopack) | 6.03s | baseline |
| vinext (Vite 7 / Rollup) | 2.52s | ~2.4x faster |
| vinext (Vite 8 / Rolldown) | 972ms | ~6x faster |

### Client bundle size (gzipped)

| Framework | Gzipped | vs Next.js |
|-----------|---------|------------|
| Next.js 16 | 168.9 KB | baseline |
| vinext (Rollup) | 76.4 KB | ~55% smaller |
| vinext (Rolldown) | 74.6 KB | ~56% smaller |

### Dev server cold start

| Framework | Mean | vs Next.js |
|-----------|------|------------|
| Next.js 16 (Turbopack) | 1.94s | baseline |
| vinext (Vite 7 / Rollup) | 1.35s | ~1.4x faster |
| vinext (Vite 8 / Rolldown) | 1.29s | ~1.5x faster |

Reproduce with `node benchmarks/run.mjs --runs=3`. Uses `hyperfine` for timing (falls back to `performance.now()`), `gzipSync` for bundle size. Historical results are tracked at [benchmarks.vinext.workers.dev](https://benchmarks.vinext.workers.dev).

## Architecture

vinext is a Vite plugin that:

1. **Resolves all `next/*` imports** to local shim modules that reimplement the Next.js API using standard Web APIs and React primitives.
2. **Scans your `pages/` and `app/` directories** to build a file-system router matching Next.js conventions.
3. **Generates virtual entry modules** for the RSC, SSR, and browser environments that handle request routing, component rendering, and client hydration.
4. **Integrates with `@vitejs/plugin-rsc`** for React Server Components — handling `"use client"` / `"use server"` directives, RSC stream serialization, and multi-environment builds.

The result is a standard Vite application that happens to be API-compatible with Next.js.

### Pages Router flow

```
Request → Vite dev server middleware → Route match → getServerSideProps/getStaticProps
  → renderToReadableStream(App + Page) → HTML with __NEXT_DATA__ → Client hydration
```

### App Router flow

```
Request → RSC entry (Vite rsc environment) → Route match → Build layout/page tree
  → renderToReadableStream (RSC payload) → SSR entry (Vite ssr environment)
  → renderToReadableStream (HTML) → Client hydration from RSC stream
```

## Project structure

```
packages/vinext/
  src/
    index.ts              # Main plugin — resolve aliases, config, virtual modules
    cli.ts                # vinext CLI (dev/build/start/deploy/check/lint)
    check.ts              # Compatibility scanner
    deploy.ts             # Cloudflare Workers deployment
    client/
      entry.ts            # Client-side hydration entry
    routing/
      pages-router.ts     # Pages Router file-system scanner
      app-router.ts       # App Router file-system scanner
    server/
      dev-server.ts       # Pages Router SSR request handler
      app-dev-server.ts   # App Router RSC entry generator
      prod-server.ts      # Production server with compression
      api-handler.ts      # Pages Router API routes
      isr-cache.ts        # ISR cache layer
      middleware.ts        # middleware.ts / proxy.ts runner
      metadata-routes.ts  # File-based metadata route scanner
      instrumentation.ts  # instrumentation.ts support
    cloudflare/
      kv-cache-handler.ts # Cloudflare KV-backed CacheHandler for ISR
    shims/                # One file per next/* module (30 shims + 6 internal)
    build/
      static-export.ts    # output: 'export' support
    config/
      next-config.ts      # next.config.js loader
      config-matchers.ts  # Config matching utilities

tests/
  *.test.ts               # Vitest unit + integration tests
  nextjs-compat/          # Tests ported from Next.js test suite
  fixtures/               # Test apps (pages-basic, app-basic, ecosystem libs)
  e2e/                    # Playwright E2E tests (5 projects)

examples/                 # Deployed demo apps (see Live Examples above)
```

## Tests

```bash
pnpm test             # Vitest unit + integration tests
pnpm run test:e2e     # Playwright E2E tests (5 projects)
pnpm run typecheck    # TypeScript checking (tsgo)
pnpm run lint         # Linting (oxlint)
```

E2E tests cover Pages Router (dev + production), App Router (dev), and both routers on Cloudflare Workers via `wrangler dev`.

The [Vercel App Router Playground](https://github.com/vercel/next-app-router-playground) runs on vinext as an integration test — see it live at [app-router-playground.vinext.workers.dev](https://app-router-playground.vinext.workers.dev).

## Local setup (from source)

If you're working from the repo instead of installing from npm:

```bash
git clone https://github.com/cloudflare/vinext.git
cd vinext
pnpm install
pnpm run build
```

This compiles the vinext package to `packages/vinext/dist/`. For active development, use `pnpm --filter vinext run dev` to run `tsc --watch`.

To use it against an external Next.js app, link the built package:

```bash
# From your Next.js project directory:
pnpm link /path/to/vinext/packages/vinext
```

Or add it to your `package.json` as a file dependency:

```json
{
  "dependencies": {
    "vinext": "file:/path/to/vinext/packages/vinext"
  }
}
```

vinext has peer dependencies on `react >= 19.2`, `react-dom >= 19.2`, and `vite >= 7.0`. Then replace `next` with `vinext` in your scripts and run as normal.

## Contributing

This project is experimental and under active development. Issues and PRs are welcome.

## License

MIT
