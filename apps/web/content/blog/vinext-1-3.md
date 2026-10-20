---
title: "Vinext 1.3: fewer requests per page, faster cold starts, and Worker Previews"
description: "Client components grouped by route, per-route SSR preloading, hash-only build output names, next.config route matching with path-to-regexp, and native Worker Previews."
date: "2026-10-20"
authors:
  - name: James Anderson
    url: https://github.com/james-elicx
tags:
  - release
  - Next.js
  - Cloudflare Workers
  - performance
  - App Router
  - next.config
---

To upgrade:

```sh
npm install vinext@1.3.0 @vinext/cloudflare@1.2.0
```

Three changes may need your attention when you upgrade:

- **Invalid `redirects`, `rewrites` and `headers` rules now fail config loading.** Vinext used to skip them at runtime. A `headers()` source written as a glob, such as `/api/*`, is one example. See [next.config route matching](#nextconfig-route-matching).
- **Client JS and CSS files have hash-only names.** `_next/static/chunks/AdminAccountMenu-<hash>.js` is now `_next/static/chunks/<hash>.js`. If something in your setup depends on those names, you can [set your own](#build-output).
- **Client components are grouped into one chunk per set of routes** in App Router production builds. `disableNextLikeChunking: true` turns this off. See [Fewer requests per page](#fewer-requests-per-page).

## Fewer requests per page

App Router production builds used to load every `"use client"` module through its own dynamic `import()`. Each client component became its own chunk, with its own shared chunks. On nodejs.org that was about 82 JS requests per page. Next.js with Turbopack serves the same site with 18–28.

Vinext now groups the client components that the same set of routes reach into one chunk. This mirrors Next.js's per-route client entries:

<table>
  <thead>
    <tr>
      <th>App</th>
      <th>JS requests per page</th>
      <th>CSS requests per page</th>
      <th>JS gzip per page</th>
      <th>4G LCP</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>nodejs.org, Vinext 1.2</td>
      <td>81.8</td>
      <td>25.8</td>
      <td>490.1 KiB</td>
      <td>957 ms</td>
    </tr>
    <tr>
      <td>nodejs.org, Vinext 1.3</td>
      <td>**25 (−69%)**</td>
      <td>**15 (−42%)**</td>
      <td>469.7 KiB (−4%)</td>
      <td>900 ms (−6%)</td>
    </tr>
    <tr>
      <td>nodejs.org, Next.js 16.2.6</td>
      <td>28</td>
      <td>5</td>
      <td>836.8 KiB</td>
      <td>852 ms</td>
    </tr>
    <tr>
      <td>fumadocs docs template, 1.2 → 1.3</td>
      <td>26.7 → **20 (−25%)**</td>
      <td>1 → 1</td>
      <td>332.0 → 330.7 KiB</td>
      <td>657 → 636 ms</td>
    </tr>
  </tbody>
</table>

"4G" is 150 ms RTT, 5 Mbit/s and a 4× CPU throttle.

A few rules keep the groups from loading code a page doesn't need:

- Client components that a route reaches through `next/dynamic` or `React.lazy` stay in their own lazy chunks.
- A component is only grouped if its own code is 100 KiB or less. Heavier ones keep their own chunk, so a large component a route can render but rarely does isn't loaded on every visit. Without this cap, hydration on 4G got about 5% slower on nodejs.org.
- Intercepting routes, `global-error` and `global-not-found` get their own groups, so a modal isn't loaded with every page.
- A group's name comes from its members, so adding a route that reaches the same components doesn't rename it.

Grouping turns itself off if your client build already sets its own chunk groups (`codeSplitting.groups`, `advancedChunks` or `manualChunks`), from your config or another plugin. You can also turn it off with `vinext({ disableNextLikeChunking: true })`, which loads each client component from its own chunk as before.

Working out the groups needs an estimate of each component's code size. Three follow-up PRs made that estimate faster, so builds take about as long as before: nodejs.org builds in 9.2 s with grouping and 9.1 s without.

## Faster cold starts

On a cold server, the first App Router SSR render loaded the client code of every page in the app before it rendered anything, and requests that arrived in the meantime waited behind it. [@jgeurts](https://github.com/jgeurts) measured 7.7 s for the first `/login` on a production app with about 250 client components, at 1 CPU.

Each render now waits only for the client components of the route it renders. The list is worked out at build time from the RSC module graph, using the same route walk as grouping. On a test app with 50 routes and 252 client components:

<table>
  <thead>
    <tr>
      <th></th>
      <th>Vinext 1.2</th>
      <th>Vinext 1.3</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>First `GET /login`</td>
      <td>228 ms</td>
      <td>42 ms</td>
    </tr>
    <tr>
      <td>First `GET` of a 5-component page</td>
      <td>234 ms</td>
      <td>48 ms</td>
    </tr>
    <tr>
      <td>Memory after the first request</td>
      <td>210 MB</td>
      <td>102 MB</td>
    </tr>
  </tbody>
</table>

Warm requests are unchanged.

The App Router browser entry also used to inline the whole route manifest, which grew with every route in the app. [@williamrogersdev](https://github.com/williamrogersdev) reported this. The browser now loads a trimmed manifest from its own chunk, alongside hydration.

## Build output

Rolldown names a chunk after its first module, so client file names published component and file names from your source. [@caumeira](https://github.com/caumeira) found that this can also break pages: the EasyList Cookie List filter `/consent-banner-` blocks the chunk for a `consent-banner.tsx` client component, and the App Router page then fails to hydrate.

Client JS is now `_next/static/chunks/[hash].js`, and CSS is `_next/static/css/[hash].css`, as in Next.js. Media files keep their names, as Next.js does.

To use other names, set `entryFileNames`, `chunkFileNames` or `assetFileNames` in `build.rolldownOptions.output` or `environments.client.build.rolldownOptions.output`. Vinext used to override these, as [@DaleyKD](https://github.com/DaleyKD) reported. It now only fills in the names you leave unset, and warns about patterns it can't serve correctly, such as names without `[hash]`. [Build output file names](/docs/reference/differences#build-output-file-names) has the rules.

Two builds of the same source now also produce the same client file names. [@quantizor](https://github.com/quantizor) reported that most client chunks were renamed on every deploy, even with `deploymentId` pinned. That made unchanged chunks miss the CDN and browser caches, and left tabs opened before a deploy unable to load them. The build ID, the RSC build identity and the RSC compatibility ID no longer reach client JS. The browser reads the values it needs from the page instead, as Next.js does. The key that names `"use cache"` exports is derived from the Server Actions encryption key, as in Next.js, instead of being random per build.

## Less of your app in the client

Every App Router page shipped the path of every `route.ts` handler in the app, in two places. Pages Router builds did the same for every `pages/api` route. That published the app's whole API surface, internal endpoints included. [@dppeak](https://github.com/dppeak) reported it, and [@tamujin](https://github.com/tamujin) fixed it for App Router builds.

- App-only builds ship no route handler paths, except where the client router needs one to avoid briefly rendering the wrong page's loading state.
- Pages Router builds ship no API route paths.
- Builds with both `app/` and `pages/` ship the handler patterns they need with every static segment replaced by a short hash. As with Next.js's client router filter, the list can't be read, but a guessed path can be checked against it.

## next.config route matching

`redirects`, `rewrites` and `headers` sources were matched by Vinext's own parser, which differed from Next.js in many cases. Some `headers()` sources from the Next.js docs never matched, so headers such as `X-Frame-Options`, CSP and HSTS were left off responses Next.js would have added them to:

<table>
  <thead>
    <tr>
      <th>Source</th>
      <th>Path</th>
      <th>Next.js</th>
      <th>Vinext 1.2</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>`/:path*`</td>
      <td>`/`</td>
      <td>match</td>
      <td>no match</td>
    </tr>
    <tr>
      <td>`/admin/:path+`</td>
      <td>`/admin/x`</td>
      <td>match</td>
      <td>no match</td>
    </tr>
    <tr>
      <td>`/admin/:id?`</td>
      <td>`/admin`</td>
      <td>match</td>
      <td>no match</td>
    </tr>
    <tr>
      <td>`/((?!api|_next/static).*)`</td>
      <td>`/admin`</td>
      <td>match</td>
      <td>no match</td>
    </tr>
  </tbody>
</table>

All three now compile with path-to-regexp, as in Next.js 16. Other fixes in the same area:

- Locale-prefixed redirects with params, such as `/:locale(en|sv)?/settings/:path*`, now fire under non-default locales.
- `headers()` substitutes matched params into header keys and values. A `value: ":slug"` used to be sent as the literal text `:slug`.
- With `i18n`, a `headers()` rule matches once, in its locale-prefixed form. Additive headers such as `Set-Cookie` were sent twice on default-locale requests.
- Config and middleware headers apply to external rewrites, and `Set-Cookie` headers from `next.config` are ordered as in Next.js.
- Regexes in sources, `has`/`missing` values and middleware matchers run as written, as in Next.js. Vinext used to check them for catastrophic backtracking, and skipped rules or ran middleware for every path when the check flagged one.
- Rewrites with `basePath: false` to internal destinations are rejected when the config loads, and rewrite destinations outside the `basePath` resolve to nothing.

Like Next.js, Vinext now fails at config load and lists every invalid route: a source that path-to-regexp rejects, a source that compiles to a regex over 4,096 characters, or a malformed `has`/`missing` entry. **An app with an invalid route that used to be skipped will now fail to start or build until it is fixed.**

## Worker Previews

[@ktKongTong](https://github.com/ktKongTong) added `previews deploy` to `@vinext/cloudflare`, which builds your app and uploads it as a [Worker Preview](/docs/deploying/cloudflare#deploy-a-worker-preview):

```sh
npx @vinext/cloudflare previews deploy pr-123
```

It needs a `cloudflare.config.ts` project and the `cf` CLI. The Preview name and the Vite mode are independent: pass `--mode` to change the build mode, and use `isPreview` in `cloudflare.config.ts` for Preview-only settings. Previews skip cache warming and version promotion. `--skip-build` uploads Preview output you built separately.

## Cloudflare

- [@JamesbbBriz](https://github.com/JamesbbBriz) fixed shared-cache renders that redirect. Since 1.0 they returned `500 TypeError: Too many redirects` instead of the redirect, which broke Payload CMS's `/admin` login redirect.
- `revalidatePath()`, `revalidateTag()` and `updateTag()` calls in one Server Action or Route Handler now send one CDN purge per request, as Next.js does, instead of one each. Workers Cache purges share a budget of 5 requests a minute per account, so an autosaving action could use it up within a minute and get a 500 even though its write had committed. A failed purge is now logged instead of failing the request, and `revalidatePath()` skips the purge for paths only `force-dynamic` routes serve. [@quantizor](https://github.com/quantizor) reported this.
- [@ash1day](https://github.com/ash1day) found that a request cancelled during app initialization could hang every later request in the isolate until it was evicted. On Workers, a pending promise belongs to the request that created it, and Vinext shares some across requests. The request that starts shared work, including a server `next/dynamic` load, now stays alive until that work settles.

## Server Actions and Route Handlers

- A fetch Server Action's arguments can only contain server references the current route owns, as in Next.js. A crafted request body could previously pass in an action owned by another route, such as one middleware protects. Progressive bound references go through the same check.
- [@pitahashi](https://github.com/pitahashi) fixed multipart POSTs to Route Handlers. They went through Server Action handling first, so bodies over 1 MiB got a 413 and cross-origin requests a 403. Progressive actions are now decided after late routing, against the final route.
- A route handler's `request.signal` no longer stops aborting after a garbage collection. SSE handlers that clean up on abort were affected.
- Route handler cookies and auth challenges are ordered after middleware's, as in Next.js.
- `res.appendHeader` works in Pages API routes.

## Other changes

- On `vinext start`, middleware compared absolute `NextResponse.rewrite()` targets against the client's `Host` header. A client could send a `Host` that made an external rewrite target count as internal, so a page middleware protects rendered without its checks. Middleware now runs against the server's own origin, as in Next.js.
- The Nitro `node-server` and `bun` presets run middleware before serving `public/` files, as Next.js does, and serve public files the router resolves. [@AhmedElBanna80](https://github.com/AhmedElBanna80) reported this, and that `_buildManifest.js` always had an empty `sortedPages`, which is also fixed.
- After a client navigation, Back on iOS Safari opened the previous App Router page at the top. Vinext now writes the history entry before the new page replaces the old one, as Next.js does. [@NathanDrake2406](https://github.com/NathanDrake2406) reported this.
- [@winstally](https://github.com/winstally) reported that a page-slot redirect could keep refetching after a failed RSC fetch in WebKit. Hard navigations now suspend the tree, so redirect boundaries can't loop.
- [@caumeira](https://github.com/caumeira) fixed `next/root-params` returning `undefined` while a stale App Router page regenerated.
- [@owjs3901](https://github.com/owjs3901) fixed static export builds that could leave out prerendered pages, and still exit 0, when a keep-alive connection was reset.
- [@Tiscs](https://github.com/Tiscs) made `vinext start` exit with an error when the port is in use. It used to log the error and exit 0.
- [@Arthur031221](https://github.com/Arthur031221) made Pages Router dev reloads faster in large apps by keeping client asset dependency lists between loads.
- Pages that import CSS and set `dynamic = "error"` no longer hang the dev server, as [@Macil](https://github.com/Macil) reported. `dynamic = "error"` pages that read `searchParams` no longer hang the RSC stream, and `"use cache"` pages error on `searchParams` as Next.js does.
- `@heroui/react` works in Server Components and is optimized by default, as [@AndreasGalster2](https://github.com/AndreasGalster2) reported. `getImageProps` from `next/image` works in Server Components, as [@GauravKumawat2002](https://github.com/GauravKumawat2002) reported.
- The dev overlay ignores window error events without an error, such as the benign `ResizeObserver loop completed` message [@sensei-woo](https://github.com/sensei-woo) reported.
- Sanitized server errors use React 19.3's `#441` message, as Next.js does with React 19.3.
- `vinext init` upgrades a declared `@vitejs/plugin-react` below Vinext's supported range, and Vinext skips unsupported copies the app resolves.
- `@vercel/og` is imported again after a failed import, `ipaddr.js` is bundled into production server builds for the image optimizer, and the Pages Router `vinext start` server doesn't serve `public/` files outside the `basePath`.

Thanks to everyone who contributed to 1.3: [@Arthur031221](https://github.com/Arthur031221), [@caumeira](https://github.com/caumeira), [@JamesbbBriz](https://github.com/JamesbbBriz), [@ktKongTong](https://github.com/ktKongTong), [@owjs3901](https://github.com/owjs3901), [@pitahashi](https://github.com/pitahashi), [@tamujin](https://github.com/tamujin) and [@Tiscs](https://github.com/Tiscs), and to [@AhmedElBanna80](https://github.com/AhmedElBanna80), [@AndreasGalster2](https://github.com/AndreasGalster2), [@ash1day](https://github.com/ash1day), [@DaleyKD](https://github.com/DaleyKD), [@dppeak](https://github.com/dppeak), [@GauravKumawat2002](https://github.com/GauravKumawat2002), [@jgeurts](https://github.com/jgeurts), [@Macil](https://github.com/Macil), [@NathanDrake2406](https://github.com/NathanDrake2406), [@quantizor](https://github.com/quantizor), [@sensei-woo](https://github.com/sensei-woo), [@williamrogersdev](https://github.com/williamrogersdev) and [@winstally](https://github.com/winstally) for their bug reports.

The full lists of changes are in the release notes for [vinext 1.3.0](https://github.com/cloudflare/vinext/releases/tag/vinext%401.3.0), [@vinext/cloudflare 1.2.0](https://github.com/cloudflare/vinext/releases/tag/%40vinext%2Fcloudflare%401.2.0) and [@cloudflare/workers-response-store 1.1.2](https://github.com/cloudflare/vinext/releases/tag/%40cloudflare%2Fworkers-response-store%401.1.2).
