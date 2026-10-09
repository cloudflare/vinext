---
title: "vinext 1.0: Next.js on Vite, ready for Cloudflare Workers"
description: "vinext 1.0 is out, with Workers Response Store, staged cache warming, typed Cloudflare config, OpenTelemetry tracing and ISR that caches what Next.js caches."
date: "2026-09-28"
version: "1.0.0"
authors:
  - name: James Anderson
    url: https://github.com/james-elicx
tags:
  - release
  - Next.js
  - Vite
  - Cloudflare Workers
  - ISR
  - caching
---

vinext 1.0 is out.

If you haven't come across it yet: vinext takes the Next.js API surface (the `app/` and `pages/` routers, React Server Components, Server Actions, middleware, ISR and the `next/*` modules you already import) and reimplements it on top of Vite. You keep your Next.js code. Vite does the dev server and the build. Cloudflare Workers gets the deepest integration, and standalone Node output and Nitro cover most other places you might want to run it.

We shipped fourteen betas between July and the end of September. Most of that time went into the unglamorous part, which was making caching behave like Next.js down to the response headers. This post covers what landed on the way to 1.0 and what the version number does and doesn't promise.

## What 1.0 means

1.0 is a stability line for vinext's own surface: the `vinext()` plugin options, the cache adapters, the `@vinext/cloudflare` deploy flags and the generated project layout. From here on, breaking changes to those get a major version.

It is **not** a claim that every Next.js app runs unchanged. Some newer App Router features still have gaps, most notably full Cache Components and Partial Prerendering. We'd rather say that plainly than have you find out in production. The [differences page](/docs/reference/differences) lists the boundaries that matter most, and the [compatibility dashboard](/compatibility) shows results from the Next.js deploy test suite, run against `main` every night.

## Try it

Start a new project:

```sh
pnpm create vinext-app@latest my-app
```

Or point it at an existing Next.js app:

```sh
npx vinext init
```

`vinext init` runs a compatibility scan first, then adds vinext next to your existing Next.js setup without touching your source files, so `next dev` keeps working while you try it. The [migration guide](/docs/getting-started/migrating) walks through the whole thing.

## Workers Response Store

The biggest addition in the 1.0 cycle is a new cache built for vinext on Cloudflare: **Workers Response Store**.

Before it existed you had to choose between trade-offs. Workers Cache is fast, but it is regional and has no durable backing store, so an entry cached in one location doesn't help a request somewhere else. KV is durable, but it is eventually consistent, and every request still runs your Worker.

Response Store layers them. Workers Cache serves hot responses at the edge, R2 holds a durable copy of every rendered response, and a SQLite-backed Durable Object tracks metadata, tags and invalidations. When the edge misses, vinext reads the stored response from R2 instead of rendering the page again. It also handles the data cache (`fetch`, `unstable_cache` and `"use cache"`), so a single system covers both caches.

```ts
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

vinext({ cache: responseStoreAdapter() });
```

It's now the default when you enable caching through `vinext init`. You can run it as a separate cache Worker over a service binding, or self-contained inside your app Worker. For high-traffic apps you can shard the metadata across several Durable Objects with `responseStoreAdapter({ shards: 16 })`. The [caching guide](/docs/guides/caching#workers-response-store) covers both modes.

## ISR that caches what Next.js caches

A cache that stores the wrong thing is worse than no cache. A lot of the late beta work went into making vinext's ISR decisions match Next.js exactly, so 1.0:

- caches an App Router page only when Next.js would classify the route as static or SSG, and defaults those pages to `revalidate = false`;
- never stores a render that touched a dynamic API like `cookies()` or `headers()`, and sends Next.js's never-cache header on pages that can't be static;
- shares one cached HTML, RSC and loading-shell entry across every query string of a static page, as Next.js does, on every backend;
- matches Next.js for `useSearchParams()` on cacheable pages: the server renders the nearest `<Suspense>` fallback and the browser fills in the real query after hydration;
- keeps serving the previous entry when a background regeneration fails, rather than surfacing the error.

None of this is flashy, but it's the difference between "the page was fast" and "the page showed someone else's data".

## Cache warming, rendered by the Worker you're deploying

Earlier versions prerendered pages on your machine during deploy and bulk-uploaded the results to KV. That skipped your real bindings, so anything that read from D1, R2 or a service binding at render time either failed or produced the wrong output.

In 1.0 that's gone. `--warm-cache` now does it properly:

```sh
npx @vinext/cloudflare deploy --warm-cache
```

vinext uploads the new Worker version, stages it at 0% of traffic, discovers your routes through the staged Worker, and requests each cacheable page so it renders with its real bindings and fills the cache. Only then does it promote the version. If warming fails, the deploy stops and your current version keeps serving. Add `--warm-cache-certify` to make a second request that proves each warmed entry is reusable before promotion.

For large sites, `--traffic-aware-warm-cache` ranks paths by real request counts from your zone analytics and warms the ones people actually visit, including dynamic paths that `generateStaticParams()` never listed.

If your site is fully immutable between deploys, there's also a new read-only **Static Assets** cache adapter that renders responses during the build and serves them straight from Workers Static Assets.

## Typed Cloudflare config with `cf`

New Cloudflare projects now use the `cf` CLI and a typed `cloudflare.config.ts` by default, along with version 2 of the Cloudflare Vite plugin and Cloudflare Build Output. Your bindings, domains and cache Workers live in TypeScript next to the rest of your config, KV namespaces can be provisioned automatically, and the manual "now go create this binding in the dashboard" steps are gone from the setup flow.

Existing Wrangler projects aren't migrated behind your back. If you'd rather stay on Wrangler for a new project, pass `--legacy-wrangler-cloudflare-init`.

## Just `vite dev` and `vite build`

vinext used to steer you towards `vinext dev` and `vinext build`. You can now run `vite dev` and `vite build` directly, and you get the full vinext lifecycle, including prerendering and Cloudflare output. The vinext commands still exist as thin aliases. vinext 1.0 requires Vite 8, so you also get Rolldown and Oxc by default.

## Tracing that works with your existing instrumentation

vinext now emits Next.js-compatible OpenTelemetry spans for requests, rendering, `fetch`, metadata and responses in both routers. You register your SDK in `instrumentation.ts`, the same file you'd use with Next.js, and there's no vinext-specific API to learn. Sentry works, and on Workers the spans show up in Cloudflare's native tracing. The [tracing guide](/docs/guides/tracing) has the setup.

## Everything else

A few more things that shipped on the way to 1.0:

- **`create-vinext-app`** scaffolds a TypeScript App Router project with Tailwind, ready to deploy to Workers or Node.
- **`@vinext/types`** ships Next.js-compatible types, so your editor is happy even after you remove `next` from your dependencies.
- **`vinext check`** now tells you which `next.config` options vinext honours and which it ignores, before you migrate.
- **React Compiler** support is available behind `react: { compiler: true }`, as an experimental option.
- **`vinext init`** detects CSS Modules setups that need a compatibility workaround and installs it for you.

## What's next

The main gaps we're still working on are full Cache Components and Partial Prerendering, build-time image and font optimization, and native modules such as `sharp` in App Router development. The [differences page](/docs/reference/differences) covers each of them in more detail.

If something in your app doesn't work, a small reproduction in a [GitHub issue](https://github.com/cloudflare/vinext/issues) is the fastest way to get it fixed. And if you've been waiting for a number without "beta" in it before trying vinext, this is it.

The full list of changes is in the [vinext 1.0.0 release notes](https://github.com/cloudflare/vinext/releases/tag/vinext%401.0.0).
