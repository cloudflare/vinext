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

## VinextOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `appDir` | `string` | project root | Custom base directory for `app/` and `pages/` |
| `rsc` | `boolean` | `true` | Auto-register `@vitejs/plugin-rsc` for App Router |

## vinext deploy flags

| Flag | Description |
|------|-------------|
| `--preview` | Deploy to preview environment |
| `--name <name>` | Override worker name |
| `--skip-build` | Skip build step (deploy existing output) |
| `--dry-run` | Generate config without deploying |
| `--experimental-tpr` | Enable Traffic-aware Pre-Rendering |
