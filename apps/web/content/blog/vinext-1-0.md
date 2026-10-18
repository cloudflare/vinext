---
title: "Vinext 1.0: stable APIs and cache warming"
description: "Caching that follows Next.js's rules, a durable cache for Cloudflare Workers, typed Cloudflare config, and OpenTelemetry tracing."
date: "2026-09-28"
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

Vinext builds Next.js apps with Vite instead of `next build`. You keep your `app/` or `pages/` directory, your `next.config` and your `next/*` imports, and deploy to Cloudflare Workers, Node, or anywhere Nitro supports. If you haven't come across it before, the [original announcement](https://blog.cloudflare.com/vinext/) explains how it started.

We released fourteen betas between July and September. Most of the work in them went into caching, so most of this post is about caching too.

## Stability

From 1.0 we'll follow semver for Vinext's own APIs: the plugin options, the cache adapters, the deploy flags and the files `vinext init` generates. Breaking changes to any of those will wait for 2.0.

Next.js compatibility is a separate question. Some App Router features, including Cache Components and Partial Prerendering, are still incomplete. The [differences page](/docs/reference/differences) lists the gaps we know about, and the [compatibility dashboard](/compatibility) shows nightly results from the Next.js deploy test suite. It's worth checking both before moving a production app over.

## Cache warming

Earlier versions prerendered pages on the machine running the deploy and uploaded them to KV. Because that happened outside your Worker, pages that read from D1, R2 or a service binding while rendering didn't work.

`--warm-cache` now uploads the new version, keeps it at 0% of traffic, and requests every cacheable page through it, so pages render with your real bindings. The version is only promoted once warming succeeds. If it fails, the deploy stops and the current version stays live.

```sh
npx @vinext/cloudflare deploy --warm-cache
```

For sites with a lot of pages, `--traffic-aware-warm-cache` uses your zone analytics to warm the most visited paths. That includes dynamic paths that aren't in `generateStaticParams()`.

## Caching rules

We spent a lot of the later betas porting Next.js's rules for what gets cached, rather than approximating them. Vinext now only caches an App Router page if Next.js would treat the route as static or SSG, and it never stores a render that used `cookies()` or `headers()`.

A static page has one cache entry for all its query strings, as in Next.js. `useSearchParams()` renders the nearest `<Suspense>` fallback on the server, then the real value after hydration. If a background regeneration fails, the previous version of the page keeps being served.

## Workers Response Store

Response Store is a new cache for Vinext on Cloudflare. Before it, you could use Workers Cache, which is fast but regional and has no durable copy, or KV, which is durable but eventually consistent and still runs your Worker on every request.

Response Store uses Workers Cache for hot responses at the edge, R2 for a durable copy of every rendered response, and a SQLite Durable Object for metadata, tags and invalidation. When the edge cache misses, Vinext reads the response from R2 rather than rendering the page again. It also covers the data cache (`fetch`, `unstable_cache` and `"use cache"`).

```ts
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

vinext({ cache: responseStoreAdapter() });
```

It's the default when you enable caching with `vinext init`, and it's what vinext.dev runs on. The [caching guide](/docs/guides/caching#workers-response-store) explains the two deployment modes and when to use sharding.

## Other changes

- New Cloudflare projects use the `cf` CLI with a typed `cloudflare.config.ts`, and KV namespaces are created automatically. Existing Wrangler projects aren't changed, and `--legacy-wrangler-cloudflare-init` keeps Wrangler for new ones.
- `vite dev` and `vite build` work directly. Vinext now requires Vite 8.
- Vinext emits Next.js-compatible OpenTelemetry spans. Set it up in `instrumentation.ts` as you would with Next.js. It works with Sentry and with Cloudflare's Workers tracing; see the [tracing guide](/docs/guides/tracing).
- `create-vinext-app` creates new projects.
- `@vinext/types` provides the Next.js types, so you can remove `next` from your dependencies.
- `vinext check` lists the `next.config` options Vinext ignores.
- React Compiler support is available as an experimental option, with `react: { compiler: true }`.

## Getting started

To start a new project:

```sh
pnpm create vinext-app@latest my-app
```

For an existing Next.js app, run this in the project:

```sh
npx vinext init
```

`init` runs a compatibility check, then adds Vinext alongside Next.js without changing your source files, so `next dev` keeps working. The [migration guide](/docs/getting-started/migrating) has the details.

Bug reports with a small reproduction are very welcome on [GitHub](https://github.com/cloudflare/vinext/issues). The [release notes](https://github.com/cloudflare/vinext/releases/tag/vinext%401.0.0) have the full list of changes.
