import { http, HttpResponse, type RequestHandler } from "msw";

/**
 * Default MSW handlers shared across the test suite.
 *
 * The `setup.ts` file enables `onUnhandledRequest: "error"`, so any request
 * issued by tests (or by fixture pages exercised through the in-process Vite
 * runtime) must be matched by a handler — either a default handler here or
 * a per-test override registered via `server.use(...)`.
 *
 * Tests register their own handlers locally; this file is for the small set
 * of requests issued by fixture pages that we cannot reasonably scope to a
 * single test file.
 */

// TODO(msw-migration): These two handlers exist so that the existing fixture
// pages under `tests/fixtures/app-basic/` keep working once the MSW guard is
// enabled. They are placeholders — follow-up PRs (or a dedicated cleanup
// pass) will replace the live external URLs in those fixtures with
// test-local endpoints, at which point these passthroughs can be removed.
//
//   - tests/fixtures/app-basic/app/revalidate-tag-test/page.tsx
//       fetches https://httpbin.org/uuid
//   - tests/fixtures/app-basic/app/layout-segment-config/dynamic-error-fetch/page.tsx
//       fetches https://example.com/not-cacheable
export const handlers: RequestHandler[] = [
  http.get("https://httpbin.org/uuid", () =>
    HttpResponse.json({ uuid: "00000000-0000-0000-0000-000000000000" }),
  ),
  http.get("https://example.com/not-cacheable", () =>
    HttpResponse.text("ok", { headers: { "cache-control": "no-store" } }),
  ),
];
