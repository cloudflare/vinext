# PPR impact fixture

This Cloudflare-configured CI fixture mirrors Next.js's root-param PPR fallback test. It does not
enable Cache Components, so it has no fallback shells and unknown blog slugs use a normal full
render.

```bash
vp run vinext#build
node ../../../packages/vinext/dist/cli.js build
node ../../../packages/vinext/dist/cli.js start --port 4187
```

Open <http://localhost:4187/en/blog/new-post>. The page should finish with `Home (en)`,
`Blog Post: new-post`, and `Comments for anonymous`, without the global error UI.

The fixture remains configured for Cloudflare Workers, but this safety test uses `vinext start`.
Worker prerender-cache population is intentionally out of scope.
