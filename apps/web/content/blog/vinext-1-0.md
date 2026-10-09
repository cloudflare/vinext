---
title: "Vinext 1.0: Next.js on Vite, ready for Cloudflare Workers"
description: "What the version number does and doesn't promise, a new cache built for Workers, and why deploys now warm it with your real bindings."
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

If you missed the [original announcement](https://blog.cloudflare.com/vinext/), here's the short version. Vinext lets you build a Next.js app with Vite instead of `next build`. Your `app/` and `pages/` directories, your `next.config`, and your imports from `next/link` and `next/navigation` all stay where they are. Under the hood it's the Next.js API surface reimplemented as a Vite plugin, and it deploys to Cloudflare Workers with one command, or to Node, or anywhere Nitro runs.

The early months were about breadth: routing, Server Components, Server Actions and middleware. The fourteen betas over the summer were a different kind of work. Most of it was caching, and most of the caching work was getting Vinext to agree with Next.js about what it's allowed to cache in the first place.

## What 1.0 does and doesn't mean

"1.0" means different things to different people, so I'll be specific.

It means Vinext's own surface is settled: the plugin options, the cache adapters, the deploy flags and the project that `vinext init` generates. If we need to break any of that, it'll be in a 2.0.

It doesn't mean every Next.js app runs unchanged. Cache Components and Partial Prerendering are still incomplete, for one. We keep a [list of the differences that matter](/docs/reference/differences), and the [compatibility dashboard](/compatibility) runs the Next.js deploy test suite against `main` every night and shows the failures as well as the passes. Look at both before you move a production app.

## A cache built for Workers

The biggest thing to land during the betas is Workers Response Store. It exists because each option we already had fell short in a different way.

Workers Cache is fast, but it's regional. A page cached in London does nothing for someone in Sydney, and there's no durable copy behind it. KV is durable, but it's eventually consistent, and every request still has to run your Worker to read from it.

Response Store stacks the pieces. Workers Cache serves hot pages at the edge. R2 keeps a durable copy of every rendered response, so an edge miss reads from R2 instead of rendering the page again. A SQLite Durable Object tracks metadata, tags and invalidations, so `revalidateTag()` knows exactly which entries to touch. It handles the data cache too (`fetch`, `unstable_cache` and `"use cache"`), so there's one thing to configure:

```ts
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

vinext({ cache: responseStoreAdapter() });
```

`vinext init` sets it up by default when you turn caching on. vinext.dev runs on it, this blog included. The [caching guide](/docs/guides/caching#workers-response-store) covers the two ways to deploy it, and when sharding is worth it.

## Caching what Next.js caches, and nothing more

A cache that stores the wrong thing is worse than having no cache. The bug you really don't want here is a visitor getting a page that was rendered for somebody else.

So a big chunk of the late betas went into porting Next.js's rules instead of approximating them. Vinext now only caches an App Router page when Next.js would class the route as static or SSG. It never stores a render that called `cookies()` or `headers()`. Query strings on a static page share one cache entry, as they do in Next.js. `useSearchParams()` renders the nearest `<Suspense>` fallback on the server and fills in the real value after hydration. And if a background regeneration throws, visitors keep getting the last good page.

None of that is exciting work, but I'm glad it's done.

## Warming the cache with your real bindings

Older versions prerendered your pages on your laptop or CI machine during deploy, then bulk-uploaded the results to KV. It was quick, but it ran outside your Worker. Anything that read from D1, R2 or a service binding while rendering either broke or rendered the wrong thing.

That's gone now. With `--warm-cache`, Vinext uploads the new version and holds it at 0% of traffic. It finds your routes through that staged Worker and requests each cacheable page, so every page renders with your real bindings. The version only goes live once the cache is warm. If warming fails, the deploy stops and your current version keeps serving.

```sh
npx @vinext/cloudflare deploy --warm-cache
```

If you have more pages than you'd want to warm on every deploy, `--traffic-aware-warm-cache` checks your zone analytics and warms the pages people actually visit, including dynamic paths that `generateStaticParams()` never listed.

## Smaller things you'll notice

New Cloudflare projects use the `cf` CLI and a typed `cloudflare.config.ts`. Bindings, domains and the cache Worker are written in TypeScript, instead of living in a config file you keep in sync by hand, and KV namespaces are created for you. Existing Wrangler projects are left alone, and `--legacy-wrangler-cloudflare-init` keeps Wrangler for new ones.

You can run `vite dev` and `vite build` directly now. Vinext requires Vite 8, so your builds go through Rolldown.

Tracing works the way it does in Next.js. Register OpenTelemetry in `instrumentation.ts` and Vinext emits spans for requests, renders, `fetch` calls and metadata. Sentry picks them up, and on Workers they show up in Cloudflare's own tracing. The [tracing guide](/docs/guides/tracing) has the setup.

There are a few odds and ends as well:

- `create-vinext-app` starts new projects.
- `@vinext/types` keeps TypeScript happy once you've removed `next` from your `package.json`.
- `vinext check` tells you which `next.config` options Vinext ignores.
- React Compiler support is available as an experimental option, behind `react: { compiler: true }`.

## Try it

Start a new app:

```sh
pnpm create vinext-app@latest my-app
```

Or run this in an existing Next.js app:

```sh
npx vinext init
```

`init` checks compatibility first. It then adds Vinext alongside Next.js without touching your source files, so `next dev` still works while you try Vinext out. The [migration guide](/docs/getting-started/migrating) walks through the whole thing.

If something breaks, the quickest way to get it fixed is a small reproduction in a [GitHub issue](https://github.com/cloudflare/vinext/issues). The full changelog is in the [1.0.0 release notes](https://github.com/cloudflare/vinext/releases/tag/vinext%401.0.0).
