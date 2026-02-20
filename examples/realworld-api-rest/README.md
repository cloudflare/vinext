# API Routes with REST

A [Next.js API routes](https://nextjs.org/docs/pages/building-your-application/routing/api-routes) example running on Cloudflare Workers via vinext. Demonstrates how to build a REST API using the Pages Router `pages/api/` convention.

## How to use

1. Install dependencies:

```bash
pnpm install
```

2. Start the dev server:

```bash
pnpm dev
```

3. Build for production:

```bash
pnpm build
```

### Deploy to Cloudflare

```bash
# Build the application
pnpm build

# Deploy to Cloudflare Workers
npx wrangler deploy
```
