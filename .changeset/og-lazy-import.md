---
"vinext": patch
---

fix(og): lazy-load `@vercel/og` so it is code-split out of the main worker entry

The `next/og` shim statically imported `@vercel/og`, so an idiomatic
`import { ImageResponse } from "next/og"` at the top of a route module pulled
the entire ~800 KB `@vercel/og` runtime (satori + resvg + embedded wasm/fonts)
into the always-loaded server entry, parsed on every cold start. The shim now
imports `@vercel/og` via a dynamic `import()` inside its async stream callback,
so the heavy runtime is always emitted as a separate chunk regardless of how the
app imports `next/og`. On the `app-router-cloudflare` example this shrinks
`dist/server/index.js` from ~1.67 MB to ~875 KB.
