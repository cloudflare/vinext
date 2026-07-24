---
"@vinext/cloudflare": patch
---

Fix TPR's zone-analytics query, and export its traffic-selection helpers

`queryTraffic` asked `httpRequestsAdaptiveGroups` for `orderBy: [sum_requests_DESC]` and `sum { requests }`. Neither exists on that dataset — the API rejects them with `unknown enum value sum_requests_DESC` and `unknown field "requests"` (schema validation, so it fails on every zone regardless of plan). Since `runTPR` treats a failed traffic query as "no traffic data" and skips gracefully, `--experimental-tpr` silently pre-rendered nothing. Corrected to `count_DESC` / `count`.

`queryTraffic`, `filterTrafficPaths`, `selectRoutes` and `resolveZoneId` are now exported from `@vinext/cloudflare/internal/tpr`, so traffic-ranked route selection can be reused with `warmCdnCache` — which is already public, but has no way to decide _which_ paths to warm.
