---
"vinext": patch
---

Fix App Router route handlers breaking fetch-based handler libraries (oRPC, Hono, …) that re-wrap the incoming request via `new Request(request, init)`.

In `"auto"` (dynamic) mode the tracked request handed to route handlers is now a genuine `Request` instance whose dynamic-access tracking is installed via own accessor properties, instead of a `Proxy`. A `Proxy` is not a real `Request`: on workerd `new Request(proxy, init)` cannot read the native internal slots and coerces the proxy to the URL string `"[object Request]"`, so the library's subsequent `new URL(request.url)` throws `TypeError: Invalid URL: [object Request]` (under Node's undici it throws `Cannot read private member #state`). This crashed every mutation routed through such a handler in production. Value-substituting static-generation modes (`force-static`, `error`) continue to use the Proxy.
