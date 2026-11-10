# Vite Config Examples

These examples stay minimal on purpose. If you add custom build tuning on Vite 8, prefer `oxc`, `optimizeDeps.rolldownOptions`, and `build.rolldownOptions` / `worker.rolldownOptions` over older `esbuild` and `build.rollupOptions` settings.

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

Cloudflare multi-environment setup. RSC plugin registration stays automatic — do **not** add an explicit
`rsc()` call, or the build fails with `[vinext] Duplicate @vitejs/plugin-rsc detected`.

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
```

`@vitejs/plugin-rsc` is an optional peer dependency: it must be installed in the project, but vinext
registers it for you. Only register it yourself after passing `rsc: false` to `vinext()`.

`vinext init --platform=cloudflare` generates this config, together with the cache and image adapters you select. Only write it by hand when customizing the setup.

## cloudflare.config.ts — Cloudflare Workers

`vinext init --platform=cloudflare` generates this file for `cf` and Cloudflare Vite plugin v2. It is the deployment source of truth. With `--cdn-cache=none --image-optimization=none`, it looks like this:

```ts
import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "my-app",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-02",
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  }),
});
```

`--image-optimization=cloudflare-images` adds `IMAGES: bindings.images()`, and `--data-cache=kv` adds `VINEXT_KV_CACHE: bindings.kv()`. Response Store and Workers Cache setups also spread a helper's config from `@vinext/cloudflare/cache/config` into `defineWorker` (its `cache`, and `exports` where the helper defines them, as well as its `env` bindings).

For a custom Worker entry, init sets `entrypoint` to `./worker/index.ts` (or `.js`) when that file exists. Unless `next.config` sets `output: "export"` (static exports serve their pages from assets before the Worker runs), the entry must hand requests to `vinext/server/fetch-handler`, or every page returns 404.

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

Define bindings in the Worker's `env` in `cloudflare.config.ts`:

```ts
import { bindings } from "cf/config";

env: {
  // ...existing bindings
  DB: bindings.d1({ name: "my-db" }),
  CACHE: bindings.kv(),
  BUCKET: bindings.r2({ name: "my-bucket" }),
},
```

Add `.cloudflare/types` to the `include` list in `tsconfig.json`. Binding types are generated there during dev and build; run `cf workers types` before a standalone type-check.

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

**For Cloudflare Workers,** Nitro works but the native integration (`npx @vinext/cloudflare deploy` / `vp exec vinext-cloudflare deploy` / `@cloudflare/vite-plugin`) is recommended for the best experience with `cloudflare:workers` bindings, KV caching, and one-command deploys.

## VinextOptions

| Option   | Type      | Default      | Description                                       |
| -------- | --------- | ------------ | ------------------------------------------------- |
| `appDir` | `string`  | project root | Custom base directory for `app/` and `pages/`     |
| `rsc`    | `boolean` | `true`       | Auto-register `@vitejs/plugin-rsc` for App Router |

## @vinext/cloudflare deploy flags

| Flag                         | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `--env <name>`               | Cloudflare mode for `cloudflare.config.ts`                        |
| `--preview`                  | Alias for `--env preview` (not a Worker Preview deployment)       |
| `--vite-config <path>`       | Vite config to build with (default: `vite.config.*`)              |
| `--skip-build`               | Skip build step (deploy existing output)                          |
| `--dry-run`                  | Validate setup without building or deploying                      |
| `--warm-cache`               | Warm discovered routes before promotion (built-in cache adapters) |
| `--traffic-aware-warm-cache` | Enable traffic-aware cache warming                                |

Run `npx @vinext/cloudflare deploy --help` for the full list.
