# Compatibility Reference

## Supported next/* Imports

All of these resolve automatically to vinext shims. Do not rewrite imports in application code.

| Import | Status | Notes |
|--------|--------|-------|
| `next/link` | Full | |
| `next/image` | Partial | Remote images via @unpic; no build-time optimization |
| `next/head` | Full | |
| `next/router` | Full | Pages Router |
| `next/navigation` | Full | App Router |
| `next/server` | Full | NextRequest, NextResponse, cookies, userAgent, after, connection |
| `next/headers` | Full | |
| `next/dynamic` | Full | |
| `next/script` | Full | |
| `next/font/google` | Partial | CDN-loaded, not self-hosted |
| `next/font/local` | Partial | Runtime injection |
| `next/og` | Full | Via @vercel/og |
| `next/cache` | Full | Pluggable CacheHandler |
| `next/form` | Full | |
| `next/legacy/image` | Full | |
| `next/error` | Full | |
| `next/config` | Full | |
| `next/document` | Full | Pages Router |
| `next/constants` | Full | |
| `next/amp` | Stub | No-op; AMP deprecated since Next.js 13 |
| `next/web-vitals` | Stub | No-op |
| `server-only` | Full | |
| `client-only` | Full | |

## Routing Features

| Feature | Supported |
|---------|-----------|
| Pages Router (`pages/`) | Yes |
| App Router (`app/`) | Yes |
| Dynamic routes `[param]` | Yes |
| Catch-all `[...slug]` | Yes |
| Optional catch-all `[[...slug]]` | Yes |
| Route groups `(group)` | Yes |
| Parallel routes `@slot` | Yes |
| Intercepting routes `(.)`, `(..)`, `(...)` | Yes |
| Route handlers (`route.ts`) | Yes |
| Middleware / `proxy.ts` (Next.js 16) | Yes |
| i18n (path prefix) | Yes |
| i18n (domain-based) | No |
| `basePath` | Yes |
| `trailingSlash` | Yes |

## Server Features

| Feature | Supported |
|---------|-----------|
| SSR (streaming) | Yes |
| React Server Components | Yes |
| Server Actions (`"use server"`) | Yes |
| `getStaticProps` / `getStaticPaths` | Yes |
| `getServerSideProps` | Yes |
| ISR (stale-while-revalidate) | Yes |
| `"use cache"` / `cacheLife()` / `cacheTag()` | Yes |
| Metadata API (`metadata`, `generateMetadata`) | Yes |
| `generateStaticParams` | Yes |
| Static export (`output: 'export'`) | Yes |
| `instrumentation.ts` | Yes |
| `connection()` | Yes |
| Pluggable CacheHandler | Yes |
| PPR (Partial Prerendering) | No — use `"use cache"` |

## Route Segment Config

| Config | Supported |
|--------|-----------|
| `revalidate` | Yes |
| `dynamic` | Yes |
| `dynamicParams` | Yes |
| `runtime` | Ignored |
| `preferredRegion` | Ignored |

## next.config.js Options

vinext loads and respects: `redirects`, `rewrites`, `headers`, `basePath`, `trailingSlash`, `i18n` (path prefix), `images`, `env`, `NEXT_PUBLIC_*` env vars, `output`.

Ignored: `webpack`, `turbopack`, `experimental.turbo`, `serverExternalPackages` (use Vite's `ssr.external`).

## Ecosystem Libraries

Tested and working:

- next-themes
- nuqs
- next-view-transitions
- next-intl (partial: `createNextIntlPlugin` requires manual webpack alias workaround, see #202)
- better-auth
- @vercel/analytics
- tailwindcss
- framer-motion
- shadcn-ui
- lucide-react
- drizzle
- prisma

## Not Supported

These features are intentionally excluded:

- Vercel-specific bindings (@vercel/og edge runtime, Vercel Analytics server bindings)
- AMP (deprecated since Next.js 13)
- `next export` (legacy — use `output: 'export'`)
- Turbopack/webpack configuration
- `next/jest` (use Vitest)
- `create-next-app` scaffolding
- Bug-for-bug parity with undocumented Next.js behavior
- Native Node modules in Workers (sharp, resvg, satori — auto-stubbed in production)
