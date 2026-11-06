---
title: "Vinext 1.1: faster builds and dev startup"
description: 'Background revalidation for revalidateTag and "use cache" on Cloudflare, compressed RSC responses, and less server work per client navigation.'
date: "2026-10-08"
authors:
  - name: James Anderson
    url: https://github.com/james-elicx
tags:
  - release
  - Next.js
  - Cloudflare Workers
  - performance
  - revalidateTag
  - use cache
---

To upgrade:

```sh
npm install vinext@1.1.0 @vinext/cloudflare@1.1.0
```

If you run Workers Response Store as a separate Worker (the default service-binding mode), deploy it as well, because this release uses a new invalidation API on it. Projects created with `vinext init` have a `deploy:response-store` script for this.

## Build and dev server performance

The [benchmarks page](/benchmarks) tracks build time and dev server cold start for a 33-route App Router app on every merge to `main`. Next.js 16 (Turbopack) and Vinext are measured in the same CI job. Timings vary a lot between CI machines, so the numbers below compare Vinext with Next.js from the same run, over the 25 runs before each release.

- Production builds went from about 17% faster than Next.js to about 27% faster.
- Dev server cold start went from about 34% slower than Next.js to about 11% slower.

Part of the dev server improvement comes from a change to the benchmark itself, which now starts Vinext with the project's own Vite+ instead of a globally installed CLI. Dev startup is still slower than Turbopack on this app. We've added a larger Pages Router app to the benchmarks to look into it.

Most of the gains came from small changes in 1.0.1 that cut unnecessary work, such as:

- skipping `vite-plugin-commonjs` for modules it doesn't rewrite;
- skipping stylesheet processing and unused source maps in scan builds;
- not loading large server modules just to use small helpers.

[@h-a-n-a](https://github.com/h-a-n-a) investigated a dev cold start regression and fixed two of these. [@jantimon](https://github.com/jantimon) fixed a regex in the Pages Router transform that could backtrack.

## Revalidation on Cloudflare

Previously, `revalidateTag()` purged every matching page from the Cloudflare caches, so the next request to each page waited for a full render. Next.js instead marks the pages stale (unless you pass `expire: 0`) and keeps serving the cached version while it regenerates in the background.

Vinext now does the same. On Workers Cache it uses the new `ctx.cache.invalidate()`, which marks entries stale instead of deleting them. Workers Response Store marks matching entries stale and revalidates them on their next request. This change also fixed data entries in Response Store that couldn't be regenerated, and so had never been invalidated.

`"use cache"` entries work the same way now. A stale entry is returned immediately and recomputed in the background, instead of being recomputed before the response continues.

## Client navigation

Vinext used to call a page component once before rendering it, so it could catch a `redirect()` or `notFound()` early and respond straight away. Next.js doesn't do this. It renders the page once and sends redirects and `notFound()` to the client router in the RSC payload. Vinext now does the same for client-side navigations, so data fetching in a page runs once per navigation, inside React's `cache()`.

Layouts have a similar early check. [@justYu2001](https://github.com/justYu2001) reported that it broke next-intl's `setRequestLocale()`. The check ran outside `cache()`, so next-intl fell back to reading `headers()`, and static pages were treated as dynamic and never prerendered or cached. The check no longer affects whether a page is dynamic; only the actual render decides that.

`generateMetadata()` and the page also share React's `cache()` now.

## RSC compression

[@jgeurts](https://github.com/jgeurts) reported that `vinext start` compressed HTML but not RSC payloads (`text/x-component`), which client navigations and Server Actions use. [@Adnan-Husayn](https://github.com/Adnan-Husayn) fixed it by porting the rules from the compression middleware that `next start` uses.

## Other fixes

- Pages that call `notFound()`, `redirect()`, `forbidden()` or `unauthorized()` are cached with their status code. Unmatched 404s are never cached.
- Cached pages have their generated metadata, such as `<title>`, in `<head>`, including pages rendered in the background by Response Store and Workers Cache.
- A prefetched `<Link>` follows a `redirect()` from the page.
- Intercepting routes work with proxy rewrites.
- Repeated slashes in URLs redirect as in Next.js.
- The dev server no longer crashes when a request body is cancelled.

Thanks to everyone who contributed to 1.1: [@Adnan-Husayn](https://github.com/Adnan-Husayn), [@AhmedElBanna80](https://github.com/AhmedElBanna80), [@mhsnook](https://github.com/mhsnook), [@SisyphusZheng](https://github.com/SisyphusZheng), [@sppidy](https://github.com/sppidy) and [@Tiscs](https://github.com/Tiscs). Thanks also to the 1.0.1 contributors: [@ash1day](https://github.com/ash1day), [@h-a-n-a](https://github.com/h-a-n-a), [@jantimon](https://github.com/jantimon), [@NriotHrreion](https://github.com/NriotHrreion), [@SammyTourani](https://github.com/SammyTourani) and [@Yi-111-a](https://github.com/Yi-111-a).

The full lists of changes are in the release notes for [vinext 1.1.0](https://github.com/cloudflare/vinext/releases/tag/vinext%401.1.0), [@vinext/cloudflare 1.1.0](https://github.com/cloudflare/vinext/releases/tag/%40vinext%2Fcloudflare%401.1.0) and [@cloudflare/workers-response-store 1.1.0](https://github.com/cloudflare/vinext/releases/tag/%40cloudflare%2Fworkers-response-store%401.1.0).
