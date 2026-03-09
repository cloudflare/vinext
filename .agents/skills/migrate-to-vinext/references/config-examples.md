# Vite Config Examples

## Pages Router — Local Development

No Cloudflare, no deployment. Simplest possible config.

```ts
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
});
```

## App Router — Local Development

vinext auto-registers `@vitejs/plugin-rsc` when an `app/` directory is detected and the `rsc` option is not `false`. No extra config needed.

```ts
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
});
```

To disable auto-registration (e.g., Pages Router only project with an unused `app/` dir):

```ts
export default defineConfig({
  plugins: [vinext({ rsc: false })],
});
```

## Pages Router — Cloudflare Workers

```ts
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext(), cloudflare()],
});
```

## App Router — Cloudflare Workers

Full manual config with explicit RSC plugin registration and Cloudflare multi-environment setup:

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
    }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
```

In most cases `vinext deploy` generates this automatically. Only use manual config when customizing the worker entry or adding bindings.

## wrangler.jsonc — Cloudflare Workers

Minimal config for deployment:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "vinext/server/app-router-entry",
  "assets": {
    "not_found_handling": "none"
  }
}
```

For custom worker entries (e.g., adding KV cache, image optimization bindings):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts",
  "assets": {
    "not_found_handling": "none",
    "binding": "ASSETS"
  },
  "images": { "binding": "IMAGES" }
}
```

## Accessing Cloudflare Bindings

Use `import { env } from "cloudflare:workers"` in server components, route handlers, and server actions. No custom worker entry needed.

```tsx
// app/page.tsx (server component)
import { env } from "cloudflare:workers";

export default async function Page() {
  const result = await env.DB.prepare("SELECT * FROM posts").all();
  return <div>{JSON.stringify(result)}</div>;
}
```

```ts
// app/api/data/route.ts (route handler)
import { env } from "cloudflare:workers";

export async function GET() {
  const value = await env.CACHE.get("key");
  return Response.json({ value });
}
```

Define bindings in `wrangler.jsonc`:

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "vinext/server/app-router-entry",
  "d1_databases": [{ "binding": "DB", "database_name": "my-db", "database_id": "..." }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "..." }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "my-bucket" }],
  "ai": { "binding": "AI" }
}
```

Run `wrangler types` to generate TypeScript types for the `env` object.

Do NOT use `getPlatformProxy()`, `getRequestContext()`, or custom worker entries with `fetch(request, env)`. These are older patterns. `cloudflare:workers` is the recommended approach.

## App Router — Other Platforms (via Nitro)

For deploying to Vercel, Netlify, AWS, Deno Deploy, or any other Nitro-supported platform:

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [vinext(), nitro()],
});
```

Build with a preset:

```bash
NITRO_PRESET=vercel npx vite build
NITRO_PRESET=netlify npx vite build
NITRO_PRESET=deno_deploy npx vite build
NITRO_PRESET=node npx vite build
```

Nitro auto-detects the platform in most CI/CD environments, so the `NITRO_PRESET` is often unnecessary.

**For Cloudflare Workers,** Nitro works but the native integration (`vinext deploy` / `@cloudflare/vite-plugin`) is recommended for the best experience with `cloudflare:workers` bindings, KV caching, and one-command deploys.

## VinextOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `appDir` | `string` | project root | Custom base directory for `app/` and `pages/` |
| `rsc` | `boolean` | `true` | Auto-register `@vitejs/plugin-rsc` for App Router |

## Known-Safe Migration Checklist (App Router)

Use this checklist to avoid common real-world regressions during vinext migration.

### 1) Auth guard must bypass vinext assets

If you use request-wide auth (`proxy.ts`), treat `/assets/*` as internal/static just like `/_next/*`.

```ts
function isInternalRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname.startsWith("/assets/")) return true; // vinext static assets
  if (request.headers.has("rsc")) return true;
  if (request.headers.has("next-action")) return true;
  return false;
}
```

### 2) Prefer API route handlers for high-volume client mutations

Avoid looped server actions for workloads like "AI parsed N entries".

Use:
- one client request to `/api/.../batch`
- server-side validation/auth in the route
- one batch write/update flow

```ts
// client
await fetch("/api/dashboard/work-blocks/batch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ entries }),
});
```

### 3) Keep dependency optimization defaults unless proven otherwise

Do not broadly add libraries to `optimizeDeps.exclude` unless you have a verified reason.
This can trigger ESM/CJS runtime mismatches in dev.

### 4) Better Auth + SIWE should use persistent/shared DB

For SIWE nonce verification reliability:
- use shared DB-backed auth storage
- ensure Better Auth tables exist (`verification` in particular)
- run explicit bootstrap migration scripts rather than relying on per-request introspection

## vinext deploy flags

| Flag | Description |
|------|-------------|
| `--preview` | Deploy to preview environment |
| `--name <name>` | Override worker name |
| `--skip-build` | Skip build step (deploy existing output) |
| `--dry-run` | Generate config without deploying |
| `--experimental-tpr` | Enable Traffic-aware Pre-Rendering |
