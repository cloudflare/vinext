# Pages Router Static Assets cache

A Pages Router app whose prerendered HTML and `/_next/data` props are packaged
into Workers Static Assets with `staticAssetsAdapter()`. Pages show
`build-time` when served from the build snapshot and `runtime` when rendered by
the Worker.

It covers automatically static pages, `getStaticProps` pages and their
`getStaticPaths` entries, build-time redirects and not-found results, custom
404/500 pages, `_document` status and content types, encoded path parameters,
and rewrites that can reach public files but never the private cache
directory. The Worker reads the cache through a custom `STATIC` binding.

```sh
vp build
vp run preview
```

The E2E suite runs against a local build and against each PR's deployed
preview:

```sh
PLAYWRIGHT_PROJECT=cloudflare-static-assets-pages vp exec playwright test
```

`/api/preview` and `/api/revalidate` are local test controls. They respond only
when the app is built with `VINEXT_E2E_CONTROLS=1`, and deployed builds return
404.

See [`static-assets-pages-i18n`](../static-assets-pages-i18n) for locale
snapshots and custom `_error` pages.
