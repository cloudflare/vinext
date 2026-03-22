# Prisma + Hyperdrive on Cloudflare Workers

A full-stack CRUD example using [Prisma](https://www.prisma.io/) with [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) for accelerated PostgreSQL access on Cloudflare Workers via vinext.

Demonstrates:
- Per-request Prisma client (avoids [alternating connection failures](https://github.com/cloudflare/vinext/issues/537))
- Hyperdrive connection pooling
- Server component data fetching
- Route handler CRUD API

## Prerequisites

- A PostgreSQL database (Neon, Supabase, or any provider)
- A Cloudflare account with Hyperdrive enabled

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Set your database URL:

```bash
echo 'DATABASE_URL="postgresql://user:pass@host:5432/db"' > .env
```

3. Create the database table:

```bash
pnpm db:push
```

4. Generate the Prisma client:

```bash
pnpm db:generate
```

5. Create a Hyperdrive config:

```bash
npx wrangler hyperdrive create my-db \
  --connection-string="postgresql://user:pass@host:5432/db"
```

6. Copy the Hyperdrive ID into `wrangler.jsonc`:

```jsonc
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<paste-id-here>" }]
```

## Development

```bash
pnpm dev
```

Open http://localhost:5173 — the app fetches items from your database via Hyperdrive.

## Deploy

```bash
pnpm build
npx wrangler deploy
```

## How it works

### The per-request client pattern

Cloudflare Workers reuse isolates across requests, but each request has its own I/O context. A global `PrismaClient` singleton causes alternating failures because the connection pool from one request becomes invalid in the next.

`lib/db.ts` solves this by creating a fresh client per call:

```ts
export function getPrisma(): PrismaClient {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}
```

Each call creates a fresh client — no cross-request state leakage. PrismaClient construction is lightweight (~0.1ms); the expensive part is the query, which Hyperdrive accelerates via edge connection pooling.

### Hyperdrive

Hyperdrive pools and caches PostgreSQL connections at Cloudflare's edge. The connection string comes from the `HYPERDRIVE` binding in `wrangler.jsonc`, accessed via `import { env } from "cloudflare:workers"`.

### Route handlers use standard Request

vinext route handlers receive the Web standard `Request` object (not `NextRequest`). Use `new URL(request.url)` to access URL components like pathname or search params.
