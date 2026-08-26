# Static export

A comprehensive hybrid App Router and Pages Router application exported by vinext as plain static assets. It has no Worker entry point and no request-time rendering fallback: Cloudflare deploys only `dist/client`.

## Run it

```sh
pnpm dev
pnpm build
pnpm verify
pnpm preview
```

`pnpm build` reads `output: "export"` from `next.config.mjs`. Unlike Next.js, which defaults to `out/`, vinext writes the deployable site to `dist/client/`:

```text
dist/client/
├── index.html
├── 404.html
├── 404/index.html
├── catalog/pocket-observatory/index.html
├── docs/deployment/cloudflare/index.html
├── legacy/index.html
├── products/atlas/index.html
├── robots.txt
└── assets and static RSC payloads
```

Deploy the directory to any static host. The hosting-only `deploy/wrangler.jsonc` uses Cloudflare Workers Static Assets. It lives outside the project root so vinext does not mistake a runtime-free export for a Worker application:

```sh
pnpm exec wrangler deploy --config deploy/wrangler.jsonc
```

`trailingSlash: true` emits directory-style `index.html` files. Its matching `html_handling: "force-trailing-slash"` setting makes the deployed canonical URLs agree with the build output, while `not_found_handling: "404-page"` preserves the generated 404 page and status.

## Capability tour

| Route | What it demonstrates |
| --- | --- |
| `/` | Build-time Server Component, CSS, and public image assets without an optimizer runtime |
| `/catalog/[slug]` | App Router `generateStaticParams`, async params, `generateMetadata`, and `notFound()` |
| `/docs/[...slug]` | Catch-all parameter expansion into concrete documents |
| `/browser-state` | Client Component hydration, state, effects, and `localStorage` |
| `/search?topic=tides` | Browser-owned query state through `useSearchParams` after static hydration |
| `/legacy` | Pages Router `getStaticProps` alongside the App Router |
| `/products/[id]` | Pages Router `getStaticPaths` with `fallback: false` |
| unknown routes | Generated `404.html` through App Router `not-found.tsx` |
| `/robots.txt`, `/icon.svg` | Static App Router metadata files |

The `scripts/verify-output.mjs` check asserts representative HTML and metadata files exist and that dynamic route template names do not leak into the artifact.

## Static export boundaries

Static export works when every response can be decided during the build or in the browser. In current vinext, that includes App Router Server and Client Components, known dynamic params, metadata, static files, custom 404s, and Pages Router SSG.

Features that need a request-time server are intentionally outside this example: `getServerSideProps`, Server Actions, middleware, cookies, request headers, draft mode, ISR/revalidation, default on-demand image optimization, and dynamic routes without a complete parameter list. Pages Router `getStaticPaths` must use `fallback: false`.

One notable parity gap remains: Next.js can emit explicitly static App Router `GET` Route Handlers as files, while vinext currently skips App Route Handlers during export. This example uses static metadata files instead of disguising that gap with a Worker endpoint.
