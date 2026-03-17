# Autoresearch Ideas

## Behavioral Differences Found

- **RSC redirect encoding**: Next.js returns 200 for RSC requests with redirect() — the redirect is encoded in the RSC stream so the client-side router handles it. Vinext returns 307 HTTP redirect for both document and RSC requests. The @vitejs/plugin-rsc client router handles this, but it's a behavioral difference that could affect client-side navigation patterns. (Found in rsc-redirect test, iteration 6)

## Promising Directories to Port Next

- **Route handler tests**: Very productive for finding API surface gaps. Check more `app-routes-*` dirs.
- **Middleware tests**: `app-middleware`, `app-middleware-proxy` — could find middleware + route handler interaction bugs.
- **Actions tests**: `actions`, `actions-navigation` — server actions are core and likely have edge cases.
- **Dynamic data tests**: `dynamic-data`, `dynamic-requests` — test request-time API access patterns.
- **Redirect/rewrite tests**: `rewrites-redirects` has 2 HTTP-level tests among its 8.
