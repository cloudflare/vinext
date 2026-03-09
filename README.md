# vinext

The Next.js API surface, reimplemented on Vite.

> **Read the announcement:** [How we rebuilt Next.js with AI in one week](https://blog.cloudflare.com/vinext/)

> 🚧 **Experimental — under heavy development.** This project is an experiment in AI-driven software development. The vast majority of the code, tests, and documentation were written by AI (Claude Code). Humans direct architecture, priorities, and design decisions, but have not reviewed most of the code line-by-line. Treat this accordingly — there will be bugs, rough edges, and things that don't work. Use at your own risk.

## Quick start

vinext includes an [Agent Skill](https://agentskills.io/home) that handles migration for you. It works with Claude Code, OpenCode, Cursor, Codex, and dozens of other AI coding tools. Install it, open your Next.js project, and tell the AI to migrate:

```sh
npx skills add cloudflare/vinext
```

Then open your Next.js project in any supported tool and say:

```
migrate this project to vinext
```

The skill handles compatibility checking, dependency installation, config generation, and dev server startup. It knows what vinext supports and will flag anything that needs manual attention.

### Or do it manually

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

Your existing `pages/`, `app/`, `next.config.js`, and `public/` directories work as-is. Run `vinext check` first to scan for known compatibility issues, or use `vinext init` to [automate the full migration](#migrating-an-existing-nextjs-project).

### CLI reference

| Command         | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `vinext dev`    | Start dev server with HMR                                               |
| `vinext build`  | Production build (multi-environment for App Router: RSC + SSR + client) |
| `vinext start`  | Start local production server for testing                               |
| `vinext deploy` | Build and deploy to Cloudflare Workers                                  |
| `vinext init`   | Migrate a Next.js project to run under vinext                           |
| `vinext check`  | Scan your Next.js app for compatibility issues before migrating         |
| `vinext lint`   | Delegate to eslint or oxlint                                            |

Options: `-p / --port <port>`, `-H / --hostname <host>`, `--turbopack` (accepted, no-op).

`vinext deploy` options: `--preview`, `--env <name>`, `--name <name>`, `--skip-build`, `--dry-run`, `--experimental-tpr`.

`vinext init` options: `--port <port>` (default: 3001), `--skip-check`, `--force`.

### Starting a new vinext project

Run `npm create next-app@latest` to create a new Next.js project, and then follow these instructions to migrate it to vinext.

In the future, we will have a proper `npm create vinext` new project workflow.

### Migrating an existing Next.js project

`vinext init` automates the migration in one command:

```bash
npx vinext init
```

This will:

1. Run `vinext check` to scan for compatibility issues
2. Install `vite` (and `@vitejs/plugin-rsc` for App Router projects) as devDependencies
3. Rename CJS config files (e.g. `postcss.config.js` -> `.cjs`) to avoid ESM conflicts
4. Add `"type": "module"` to `package.json`
5. Add `dev:vinext` and `build:vinext` scripts to `package.json`
6. Generate a minimal `vite.config.ts`

The migration is non-destructive -- your existing Next.js setup continues to work alongside vinext. It does not modify `next.config`, `tsconfig.json`, or any source files, and it does not remove Next.js dependencies.

```bash
npm run dev:vinext    # Start the vinext dev server (port 3001)
npm run dev           # Still runs Next.js as before
```

Use `--force` to overwrite an existing `vite.config.ts`, or `--skip-check` to skip the compatibility report.

## Why

Vite has become the default build tool for modern web frameworks — fast HMR, a clean plugin API, native ESM, and a growing ecosystem. With [`@vitejs/plugin-rsc`](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc) adding React Server Components support, it's now possible to build a full RSC framework on Vite.

vinext is an experiment: can we reimplement the Next.js API surface on Vite, so that existing Next.js applications can run on a completely different toolchain? The answer, so far, is mostly yes — about 94% of the API surface works.

vinext works everywhere. It natively supports Cloudflare Workers (with `vinext deploy`, bindings, KV caching), and can be deployed to Vercel, Netlify, AWS, Deno Deploy, and more via the [Nitro](https://v3.nitro.build/) Vite plugin. Native support for additional platforms is [planned](https://github.com/cloudflare/vinext/issues/80).

**Alternatives worth knowing about:**

- **[OpenNext](https://opennext.js.org/)** — adapts `next build` output for AWS, Cloudflare, and other platforms. OpenNext has been around much longer than vinext, is more mature, and covers more of the Next.js API surface because it builds on top of Next.js's own output rather than reimplementing it. If you want the safer, more proven option, start there.
- **[Next.js self-hosting](https://nextjs.org/docs/app/building-your-application/deploying#self-hosting)** — Next.js can be deployed to any Node.js server, Docker container, or as a static export.

### Design principles

- **Deploy anywhere.** Natively supports Cloudflare Workers, with other platforms available via Nitro. Native adapters for more platforms are [planned](https://github.com/cloudflare/vinext/issues/80).
- **Pragmatic compatibility, not bug-for-bug parity.** Targets 95%+ of real-world Next.js apps. Edge cases that depend on undocumented Vercel behavior are intentionally not supported.
- **Latest Next.js only.** Targets Next.js 16.x. No support for deprecated APIs from older versions.
- **Incremental adoption.** Drop in the plugin, fix what breaks, deploy.

## FAQ

**What is this?**
vinext is a Vite plugin that reimplements the public Next.js API — routing, server rendering, `next/*` module imports, the CLI — so you can run Next.js applications on Vite instead of the Next.js compiler toolchain. It can be deployed anywhere: Cloudflare Workers is the first natively supported target, with other platforms available via Nitro. Native adapters for more platforms are [planned](https://github.com/cloudflare/vinext/issues/80).

**Is this a fork of Next.js?**
No. vinext is an alternative implementation of the Next.js API surface built on Vite. It does import some Next.js types and utilities, but the core is written from scratch. The goal is not to create a competing framework or add features beyond what Next.js offers — it's an experiment in how far AI-driven development and Vite's toolchain can go in replicating an existing, well-defined API surface.

**How is this different from OpenNext?**
[OpenNext](https://opennext.js.org/) adapts the _output_ of a standard `next build` to run on various platforms. Because it builds on Next.js's own output, it inherits broad API coverage and has been well-tested for much longer. vinext takes a different approach: it reimplements the Next.js APIs on Vite from scratch, which means faster builds and smaller bundles, but less coverage of the long tail of Next.js features. If you need a mature, well-tested way to run Next.js outside Vercel, OpenNext is the safer choice. If you're interested in experimenting with a lighter toolchain and don't need every Next.js API, vinext might be worth a look.

**Can I use this in production?**
You can, with caution. This is experimental software with known bugs. It works well enough for demos and exploration, but it hasn't been battle-tested with real production traffic.

**Can I just self-host Next.js?**
Yes. Next.js supports [self-hosting](https://nextjs.org/docs/app/building-your-application/deploying#self-hosting) on Node.js servers, Docker containers, and static exports. If you're happy with the Next.js toolchain and just want to run it somewhere other than Vercel, self-hosting is the simplest path.

**How are you verifying this works?**
The test suite has over 1,700 Vitest tests and 380 Playwright E2E tests. This includes tests ported directly from the [Next.js test suite](https://github.com/vercel/next.js/tree/canary/test) and [OpenNext's Cloudflare conformance suite](https://github.com/opennextjs/opennextjs-cloudflare), covering routing, SSR, RSC, server actions, caching, metadata, middleware, streaming, and more. Vercel's [App Router Playground](https://github.com/vercel/next-app-router-playground) also runs on vinext as an integration test. See the [Tests](#tests) section and `tests/nextjs-compat/TRACKING.md` for details.

**Who is reviewing this code?**
Mostly nobody. This is an experiment in seeing how far AI-driven development can go. The test suite is the primary quality gate — not human code review. Contributions and code review are welcome.

**Why Vite?**
Vite is an excellent build tool with a rich plugin ecosystem, first-class ESM support, and fast HMR. The [`@vitejs/plugin-rsc`](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc) plugin adds React Server Components support with multi-environment builds. This project is an experiment to see how much of the Next.js developer experience can be replicated on top of Vite's infrastructure.

**Does this support the Pages Router, App Router, or both?**
Both. File-system routing, SSR, client hydration, and deployment to Cloudflare Workers work for both routers.

**What version of Next.js does this target?**
Next.js 16.x. No support for deprecated APIs from older versions.

**Can I deploy to AWS/Netlify/other platforms?**
Yes. Add the [Nitro](https://v3.nitro.build/) Vite plugin alongside vinext, and you can deploy to Vercel, Netlify, AWS Amplify, Deno Deploy, Azure, and [many more](https://v3.nitro.build/deploy). See [Other platforms (via Nitro)](#other-platforms-via-nitro) for setup. For Cloudflare Workers, the native integration (`vinext deploy`) gives you the smoothest experience. Native adapters for more platforms are [planned](https://github.com/cloudflare/vinext/issues/80).

**What happens when Next.js releases a new feature?**
We track the public Next.js API surface and add support for new stable features. Experimental or unstable Next.js features are lower priority. The plan is to add commit-level tracking of the Next.js repo so we can stay current as new versions are released.

## Deployment

### Cloudflare Workers

vinext has native integration with Cloudflare Workers through `@cloudflare/vite-plugin`, including bindings access via `cloudflare:workers`, KV caching, image optimization, and the `vinext deploy` one-command workflow.

#### Prerequisites

Before running `vinext deploy` for the first time you need to authenticate with Cloudflare and tell wrangler which account to deploy to.

**Authentication — pick one:**

- **`wrangler login`** (recommended for local development) — opens a browser window to authenticate. Run it once and wrangler caches the token.
- **`CLOUDFLARE_API_TOKEN` env var** (CI / non-interactive) — create a token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) using the **Edit Cloudflare Workers** template. That template grants all the permissions `vinext deploy` needs.

**Account ID:**

wrangler needs to know which Cloudflare account to deploy to. Add your account ID to `wrangler.jsonc`:

```jsonc
{
  "account_id": "<your-account-id>",
  ...
}
```

Find your account ID in the Cloudflare dashboard URL (`dash.cloudflare.com/<account-id>`) or by running `wrangler whoami` after logging in.

Alternatively, set the `CLOUDFLARE_ACCOUNT_ID` environment variable instead of hardcoding it in the config file.

`vinext deploy` auto-generates the necessary configuration files (`vite.config.ts`, `wrangler.jsonc`, `worker/index.ts`) if they don't exist, builds the application, and deploys to Workers.

```bash
vinext deploy
vinext deploy --env staging
```

Use `--env <name>` to target `wrangler.jsonc` `env.<name>`. `--preview` is shorthand for `--env preview`.

The deploy command also auto-detects and fixes common migration issues:

- Adds `"type": "module"` to package.json if missing
- Resolves tsconfig.json path aliases automatically (via `vite-tsconfig-paths`)
- Detects MDX usage and configures `@mdx-js/rollup`
- Renames CJS config files (postcss.config.js, etc.) to `.cjs` when needed
- Detects native Node.js modules (sharp, resvg, satori, lightningcss, @napi-rs/canvas) and auto-stubs them for Workers. If you encounter others that need stubbing, PRs are welcome.

Both App Router and Pages Router work on Workers with full client-side hydration.

#### Cloudflare Bindings (D1, R2, KV, AI, etc.)

Use `import { env } from "cloudflare:workers"` to access bindings in any server component, route handler, or server action. No custom worker entry or special configuration required.

```tsx
import { env } from "cloudflare:workers";

export default async function Page() {
  const result = await env.DB.prepare("SELECT * FROM posts").all();
  return <div>{JSON.stringify(result)}</div>;
}
```

This works because `@cloudflare/vite-plugin` runs the RSC environment in workerd, where `cloudflare:workers` is a native module. In production builds, the import is externalized so workerd resolves it at runtime. All binding types are supported: D1, R2, KV, Durable Objects, AI, Queues, Vectorize, Browser Rendering, etc.

Define your bindings in `wrangler.jsonc` as usual:

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{ "binding": "DB", "database_name": "my-db", "database_id": "..." }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "..." }],
}
```

For TypeScript types, generate them with `wrangler types` and the `env` import will be fully typed.

> **Note:** You do not need `getPlatformProxy()`, a custom worker entry with `fetch(request, env)`, or any other workaround. `cloudflare:workers` is the recommended way to access bindings in vinext.

#### Traffic-aware Pre-Rendering (experimental)

TPR queries Cloudflare zone analytics at deploy time to find which pages actually get traffic, pre-renders only those, and uploads them to KV cache. The result is SSG-level latency for popular pages without pre-rendering your entire site.

```bash
vinext deploy --experimental-tpr                    # Pre-render pages covering 90% of traffic
vinext deploy --experimental-tpr --tpr-coverage 95  # More aggressive coverage
vinext deploy --experimental-tpr --tpr-limit 500    # Cap at 500 pages
vinext deploy --experimental-tpr --tpr-window 48    # Use 48h of analytics
```

Requires a custom domain (zone analytics are unavailable on `*.workers.dev`) and `CLOUDFLARE_API_TOKEN` with Zone.Analytics read permission.

For production caching (ISR), use the built-in Cloudflare KV cache handler:

```ts
import { KVCacheHandler } from "vinext/cloudflare";
import { setCacheHandler } from "next/cache";

setCacheHandler(new KVCacheHandler(env.MY_KV_NAMESPACE));
```

#### Custom Vite configuration

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
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
```

See the [examples](#live-examples) for complete working configurations.

### Other platforms (via Nitro)

For deploying to platforms other than Cloudflare, vinext works with [Nitro](https://v3.nitro.build/) as a Vite plugin. Add `nitro` alongside `vinext` in your Vite config and deploy to any [Nitro-supported platform](https://v3.nitro.build/deploy).

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [vinext(), nitro()],
});
```

```bash
npm install nitro
```

Nitro auto-detects the deployment platform in most CI/CD environments (Vercel, Netlify, AWS Amplify, Azure, and others), so you typically don't need to set a preset. For local builds, set the `NITRO_PRESET` environment variable:

```bash
NITRO_PRESET=vercel npx vite build
NITRO_PRESET=netlify npx vite build
NITRO_PRESET=deno_deploy npx vite build
```

> **Deploying to Cloudflare?** You can use Nitro, but the native integration (`vinext deploy` / `@cloudflare/vite-plugin`) is recommended. It provides the best developer experience with `cloudflare:workers` bindings, KV caching, image optimization, and one-command deploys.

<details>
<summary>Vercel</summary>

Nitro auto-detects Vercel in CI. For local builds:

```bash
NITRO_PRESET=vercel npx vite build
```

Deploy with the [Vercel CLI](https://vercel.com/docs/cli) or connect your Git repo in the Vercel dashboard. Set the build command to `vite build` and the output directory to `.output`.

</details>

<details>
<summary>Netlify</summary>

Nitro auto-detects Netlify in CI. For local builds:

```bash
NITRO_PRESET=netlify npx vite build
```

Deploy with the [Netlify CLI](https://docs.netlify.com/cli/get-started/) or connect your Git repo. Set the build command to `vite build`.

</details>

<details>
<summary>AWS (Amplify)</summary>

Nitro auto-detects AWS Amplify in CI. For local builds:

```bash
NITRO_PRESET=aws_amplify npx vite build
```

Connect your Git repo in the AWS Amplify console. Set the build command to `vite build`.

</details>

<details>
<summary>Deno Deploy</summary>

```bash
NITRO_PRESET=deno_deploy npx vite build
cd .output
deployctl deploy --project=my-project server/index.ts
```

</details>

<details>
<summary>Node.js server</summary>

```bash
NITRO_PRESET=node npx vite build
node .output/server/index.mjs
```

This produces a standalone Node.js server. Suitable for Docker, VMs, or any environment that can run Node.

</details>

See the [Nitro deployment docs](https://v3.nitro.build/deploy) for the full list of supported platforms and provider-specific configuration.

## Live examples

These are deployed to Cloudflare Workers and updated on every push to `main`:

| Example                | Description                                                                                                      | URL                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| App Router Playground  | [Vercel's Next.js App Router Playground](https://github.com/vercel/next-app-router-playground) running on vinext | [app-router-playground.vinext.workers.dev](https://app-router-playground.vinext.workers.dev)     |
| Hacker News            | HN clone (App Router, RSC)                                                                                       | [hackernews.vinext.workers.dev](https://hackernews.vinext.workers.dev)                           |
| Nextra Docs            | Nextra docs site (MDX, App Router)                                                                               | [nextra-docs-template.vinext.workers.dev](https://nextra-docs-template.vinext.workers.dev)       |
| App Router (minimal)   | Minimal App Router on Workers                                                                                    | [app-router-cloudflare.vinext.workers.dev](https://app-router-cloudflare.vinext.workers.dev)     |
| Pages Router (minimal) | Minimal Pages Router on Workers                                                                                  | [pages-router-cloudflare.vinext.workers.dev](https://pages-router-cloudflare.vinext.workers.dev) |
| RealWorld API          | REST API routes example                                                                                          | [realworld-api-rest.vinext.workers.dev](https://realworld-api-rest.vinext.workers.dev)           |
| Benchmarks Dashboard   | Build performance tracking over time (D1-backed)                                                                 | [benchmarks.vinext.workers.dev](https://benchmarks.vinext.workers.dev)                           |
| App Router + Nitro     | App Router deployed via Nitro (multi-platform)                                                                   | [examples/app-router-nitro](examples/app-router-nitro)                                           |

## API coverage

~94% of the Next.js 16 API surface has full or partial support. The remaining gaps are intentional stubs for deprecated features and Partial Prerendering (which Next.js 16 reworked into `"use cache"` — that directive is fully supported).

> ✅ = full implementation | 🟡 = partial (runtime behavior correct, some build-time optimizations missing) | ⬜ = intentional stub/no-op

### Module shims

Every `next/*` import is shimmed to a Vite-compatible implementation.

| Module              |     | Notes                                                                                                                                  |
| ------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `next/link`         | ✅  | All props including `prefetch` (IntersectionObserver), `onNavigate`, scroll restoration, `basePath`, `locale`                          |
| `next/image`        | 🟡  | Remote images via [@unpic/react](https://unpic.pics) (28 CDNs). Local images via `<img>` + srcSet. No build-time optimization/resizing |
| `next/head`         | ✅  | SSR collection + client-side DOM manipulation                                                                                          |
| `next/router`       | ✅  | `useRouter`, `Router` singleton, events, client-side navigation, SSR context, i18n                                                     |
| `next/navigation`   | ✅  | `usePathname`, `useSearchParams`, `useParams`, `useRouter`, `redirect`, `notFound`, `forbidden`, `unauthorized`                        |
| `next/server`       | ✅  | `NextRequest`, `NextResponse`, `NextURL`, cookies, `userAgent`, `after`, `connection`, `URLPattern`                                    |
| `next/headers`      | ✅  | Async `headers()`, `cookies()`, `draftMode()`                                                                                          |
| `next/dynamic`      | ✅  | `ssr: true`, `ssr: false`, `loading` component                                                                                         |
| `next/script`       | ✅  | All 4 strategies (`beforeInteractive`, `afterInteractive`, `lazyOnload`, `worker`)                                                     |
| `next/font/google`  | 🟡  | Runtime CDN loading. No self-hosting, font subsetting, or fallback metrics                                                             |
| `next/font/local`   | 🟡  | Runtime `@font-face` injection. Not extracted at build time                                                                            |
| `next/og`           | ✅  | OG image generation via `@vercel/og` (Satori + resvg)                                                                                  |
| `next/cache`        | ✅  | `revalidateTag`, `revalidatePath`, `unstable_cache`, pluggable `CacheHandler`, `"use cache"` with `cacheLife()` and `cacheTag()`       |
| `next/form`         | ✅  | GET form interception + POST server action delegation                                                                                  |
| `next/legacy/image` | ✅  | Translates legacy props to modern Image                                                                                                |
| `next/error`        | ✅  | Default error page component                                                                                                           |
| `next/config`       | ✅  | `getConfig` / `setConfig`                                                                                                              |
| `next/document`     | ✅  | `Html`, `Head`, `Main`, `NextScript`                                                                                                   |
| `next/constants`    | ✅  | All phase constants                                                                                                                    |
| `next/amp`          | ⬜  | No-op (AMP is deprecated)                                                                                                              |
| `next/web-vitals`   | ⬜  | No-op (use the `web-vitals` library directly)                                                                                          |

### Routing

| Feature                          |     | Notes                                                                                                              |
| -------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------ |
| File-system routing (`pages/`)   | ✅  | Automatic scanning with hot-reload on file changes                                                                 |
| File-system routing (`app/`)     | ✅  | Pages, routes, layouts, templates, loading, error, not-found, forbidden, unauthorized                              |
| Dynamic routes `[param]`         | ✅  | Both routers                                                                                                       |
| Catch-all `[...slug]`            | ✅  | Both routers                                                                                                       |
| Optional catch-all `[[...slug]]` | ✅  | Both routers                                                                                                       |
| Route groups `(group)`           | ✅  | URL-transparent, layouts still apply                                                                               |
| Parallel routes `@slot`          | ✅  | Discovery, layout props, `default.tsx`, inherited slots                                                            |
| Intercepting routes              | ✅  | `(.)`, `(..)`, `(..)(..)`, `(...)` conventions                                                                     |
| Route handlers (`route.ts`)      | ✅  | Named HTTP methods, auto OPTIONS/HEAD, cookie attachment                                                           |
| Middleware                       | ✅  | `middleware.ts` and `proxy.ts` (Next.js 16). Matcher patterns (string, array, regex, `:param`, `:path*`, `:path+`) |
| i18n routing                     | 🟡  | Pages Router locale prefix, Accept-Language detection, NEXT_LOCALE cookie. No domain-based routing                 |
| `basePath`                       | ✅  | Applied everywhere — URLs, Link, Router, navigation hooks                                                          |
| `trailingSlash`                  | ✅  | 308 redirects to canonical form                                                                                    |

### Server features

| Feature                            |     | Notes                                                                                       |
| ---------------------------------- | --- | ------------------------------------------------------------------------------------------- |
| SSR (Pages Router)                 | ✅  | Streaming, `_app`/`_document`, `__NEXT_DATA__`, hydration                                   |
| SSR (App Router)                   | ✅  | RSC pipeline, nested layouts, streaming, nav context for client components                  |
| `getStaticProps`                   | ✅  | Props, redirect, notFound, revalidate                                                       |
| `getStaticPaths`                   | ✅  | `fallback: false`, `true`, `"blocking"`                                                     |
| `getServerSideProps`               | ✅  | Full context including locale                                                               |
| ISR                                | ✅  | Stale-while-revalidate, pluggable `CacheHandler`, background regeneration                   |
| Server Actions (`"use server"`)    | ✅  | Action execution, FormData, re-render after mutation, `redirect()` in actions               |
| React Server Components            | ✅  | Via `@vitejs/plugin-rsc`. `"use client"` boundaries work correctly                          |
| Streaming SSR                      | ✅  | Both routers                                                                                |
| Metadata API                       | ✅  | `metadata`, `generateMetadata`, `viewport`, `generateViewport`, title templates             |
| `generateStaticParams`             | ✅  | With `dynamicParams` enforcement                                                            |
| Metadata file routes               | ✅  | sitemap.xml, robots.txt, manifest, favicon, OG images (static + dynamic)                    |
| Static export (`output: 'export'`) | ✅  | Generates static HTML/JSON for all routes                                                   |
| `connection()`                     | ✅  | Forces dynamic rendering                                                                    |
| `"use cache"` directive            | ✅  | File-level and function-level. `cacheLife()` profiles, `cacheTag()`, stale-while-revalidate |
| `instrumentation.ts`               | ✅  | `register()` and `onRequestError()` callbacks                                               |
| Route segment config               | 🟡  | `revalidate`, `dynamic`, `dynamicParams`. `runtime` and `preferredRegion` are ignored       |

### Configuration

| Feature                                          |     | Notes                                                               |
| ------------------------------------------------ | --- | ------------------------------------------------------------------- |
| `next.config.js` / `.ts` / `.mjs`                | ✅  | Function configs, phase argument                                    |
| `rewrites` / `redirects` / `headers`             | ✅  | All phases, param interpolation                                     |
| Environment variables (`.env*`, `NEXT_PUBLIC_*`) | ✅  | Auto-loads Next.js-style dotenv files; only public vars are inlined |
| `images` config                                  | 🟡  | Parsed but not used for optimization                                |

### Environment variable loading (`.env*`)

vinext automatically loads dotenv files for `dev`, `build`, `start`, and `deploy`.

Load order matches Next.js (highest priority first):

1. Existing `process.env` values (shell/CI)
2. `.env.<mode>.local`
3. `.env.local` (skipped when mode is `test`)
4. `.env.<mode>`
5. `.env`

Modes:

- `vinext dev` uses `development`
- `vinext build`, `vinext start`, and `vinext deploy` use `production`

Variable expansion (`$VAR` / `${VAR}`) is supported.

Client exposure remains explicit:

- `NEXT_PUBLIC_*` variables are inlined for browser usage
- `next.config.js` `env` entries are also inlined
- Other env vars stay server-only unless you explicitly expose them through Vite (for example `VITE_*` + `import.meta.env`)

Override behavior:

- To override any `.env*` value, set it in your shell/CI environment before running vinext. Existing `process.env` always wins.

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

- **Image optimization doesn't happen at build time.** Remote images work via `@unpic/react` (auto-detects 28 CDN providers). Local images are routed through a `/_vinext/image` endpoint that can resize and transcode on Cloudflare Workers (via the Images binding) in production, but no build-time optimization or static resizing occurs.
- **Google Fonts are loaded from the CDN, not self-hosted.** No `size-adjust` fallback font metrics. Local fonts work but `@font-face` CSS is injected at runtime, not extracted at build time.
- **`useSelectedLayoutSegment(s)`** derives segments from the pathname rather than being truly layout-aware. May differ from Next.js in edge cases with parallel routes.
- **Route segment config** — `runtime` and `preferredRegion` are ignored (everything runs in the same environment).
- **Node.js production server (`vinext start`)** works for testing but is less complete than Workers deployment. Cloudflare Workers is the primary target.
- **Native Node modules (sharp, resvg, satori, lightningcss, @napi-rs/canvas)** crash Vite's RSC dev environment. Dynamic OG image/icon routes using these work in production builds but not in dev mode. These are auto-stubbed during `vinext deploy`.

## Benchmarks

> **Caveat:** Benchmarks are hard to get right and these are early results. Take them as directional, not definitive.

These benchmarks measure **compilation and bundling speed**, not production serving performance. Next.js and vinext have fundamentally different default approaches: Next.js statically pre-renders pages at build time (making builds slower but production serving faster for static content), while vinext server-renders all pages on each request. To make the comparison apples-to-apples, the benchmark app uses `export const dynamic = "force-dynamic"` to disable Next.js static pre-rendering — both frameworks are doing the same work: compiling, bundling, and preparing server-rendered routes.

The benchmark app is a shared 33-route App Router application (server components, client components, dynamic routes, nested layouts, API routes) built identically by both tools. We compare Next.js 16 (Turbopack) against vinext on both Vite 7 (Rollup) and Vite 8 (Rolldown). Turbopack and Rolldown both parallelize across cores, so results on machines with more cores may differ significantly.

We measure three things:

- **Production build time** — 5 runs, timed with `hyperfine`.
- **Client bundle size** — gzipped output of each build.
- **Dev server cold start** — 10 runs, randomized execution order. Vite's dependency optimizer cache is cleared before each run.

Benchmarks run on GitHub CI runners (2-core Ubuntu) on every merge to `main`. See the launch numbers in the [announcement blog post](https://blog.cloudflare.com/vinext/) and the latest results at **[benchmarks.vinext.workers.dev](https://benchmarks.vinext.workers.dev)**.

<details>
<summary>Why the bundle size difference?</summary>

Analysis of the build output shows two main factors:

1. **Tree-shaking**: Vite/Rollup produces a smaller React+ReactDOM bundle than Next.js/Turbopack. Rollup's more aggressive dead-code elimination accounts for roughly half the overall difference.
2. **Framework overhead**: Next.js ships more client-side infrastructure (router, Turbopack runtime loader, prefetching, error handling) than vinext's lighter client runtime.

Both frameworks ship the same app code and the same RSC client runtime (`react-server-dom-webpack`). The difference is in how much of React's internals survive tree-shaking and how much framework plumbing each tool adds.

</details>

Reproduce with `node benchmarks/run.mjs --runs=5 --dev-runs=10`. Exact framework versions are recorded in each result.

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
    cli.ts                # vinext CLI (dev/build/start/deploy/init/check/lint)
    check.ts              # Compatibility scanner
    deploy.ts             # Cloudflare Workers deployment
    init.ts               # vinext init — one-command migration for Next.js apps
    client/
      entry.ts            # Client-side hydration entry
    routing/
      pages-router.ts     # Pages Router file-system scanner
      app-router.ts       # App Router file-system scanner
    entries/
      app-rsc-entry.ts    # App Router RSC entry generator
      app-ssr-entry.ts    # App Router SSR entry generator
      app-browser-entry.ts # App Router browser entry generator
      pages-server-entry.ts # Pages Router SSR entry generator
      pages-client-entry.ts # Pages Router client entry generator
    server/
      dev-server.ts       # Pages Router SSR request handler
      prod-server.ts      # Production server with compression
      api-handler.ts      # Pages Router API routes
      isr-cache.ts        # ISR cache layer
      middleware.ts        # middleware.ts / proxy.ts runner
      metadata-routes.ts  # File-based metadata route scanner
      instrumentation.ts  # instrumentation.ts support
    cloudflare/
      kv-cache-handler.ts # Cloudflare KV-backed CacheHandler for ISR
    shims/                # One file per next/* module (33 shims + 6 internal)
    build/
      static-export.ts    # output: 'export' support
    utils/
      project.ts          # Shared project utilities (ESM, CJS, package manager detection)
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
pnpm run fmt          # Formatting (oxfmt)
pnpm run fmt:check    # Check formatting without writing
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

vinext has peer dependencies on `react ^19.2.4`, `react-dom ^19.2.4`, and `vite ^7.0.0`. Then replace `next` with `vinext` in your scripts and run as normal.

## Contributing

This project is experimental and under active development. Issues and PRs are welcome.

### CI

When you open a PR, CI (lint, typecheck, Vitest, Playwright E2E) runs automatically. First-time contributors need one manual approval from a maintainer, then subsequent PRs run without intervention.

Deploy previews (building and deploying examples to Cloudflare Workers) only run for branches pushed to the main repo. If you're a Cloudflare employee, push your branch to the main repo instead of forking, and previews deploy automatically. For fork PRs, a maintainer can comment `/deploy-preview` to trigger the deploy and post preview URLs.

### Reporting bugs

If something doesn't work with your Next.js app, please file an issue — we want to hear about it.

Before you do, try pointing an AI agent at the problem. Open your project with Claude Code, Cursor, OpenCode, or whatever you use, and ask it to figure out why your app isn't working with vinext. In our experience, agents are very good at tracing through the vinext source, identifying the gap or bug, and often producing a fix or at least a clear diagnosis. An issue that includes "here's what the agent found" is significantly more actionable than "it doesn't work."

Even a partial diagnosis helps — stack traces, which `next/*` import is involved, whether it's a dev or production build issue, App Router vs Pages Router. The more context, the faster we can fix it.

## License

MIT
