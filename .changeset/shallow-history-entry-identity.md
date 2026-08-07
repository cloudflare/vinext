---
"vinext": patch
---

App Router: `usePathname()`/`useSearchParams()` no longer freeze on a stale URL after Back/Forward around shallow routing. Externally written history entries (app-called `history.pushState`/`replaceState`) now get their own traversal index instead of inheriting the current entry's, so a traversal can no longer restore the aliased entry's router snapshot; and the same-route popstate fast path resyncs the navigation shim's cached URL state from the restored location (#1541).
