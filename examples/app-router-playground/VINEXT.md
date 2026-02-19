# App Router Playground on vinext

This is [Vercel's Next.js App Router Playground](https://github.com/vercel/next-app-router-playground)
adapted to run on **vinext** (Vite) instead of Next.js.

## Quick Start

```bash
# From the monorepo root, build the plugin first:
npx tsc -p packages/vinext/tsconfig.json

# Install deps for this fixture:
cd fixtures/ecosystem/app-router-playground
npm install --legacy-peer-deps

# Run dev server:
npx vite dev
```

## What Works

- Nested layouts, loading states, error boundaries, not-found pages
- Dynamic routes with async params (`await params`)
- Parallel routes (`@audience`, `@views`)
- Route groups (`(checkout)`, `(main)/(shop)`, `(main)/(marketing)`)
- Server Components with data fetching
- Client Components (`'use client'`)
- Server Actions (`'use server'`)
- MDX pages with CodeHike syntax highlighting and `!!col` directives
- `next/link` with `useLinkStatus`
- `next/image`, `next/font/google`, `next/navigation`, `next/headers`
- Tailwind CSS v4
- Metadata API (`generateMetadata`, `export const metadata`)

## Known Limitations

- `'use cache'` directives work for function-level caching but page-level caching is ISR-based
- MDX files (.mdx) are not yet supported — pages that import readme.mdx will error
- CodeHike syntax highlighting not available without MDX
- `styled-components` SSR not configured (not actively used in the playground)
- View Transitions API depends on React 19 canary features

## Deploy to Cloudflare

```bash
# Build for production
npx vite build

# Deploy to Cloudflare Workers
npx wrangler deploy
```
