import { http, passthrough, type RequestHandler } from "msw";

/**
 * Default MSW handlers shared across the test suite.
 *
 * `tests/_msw/setup.ts` enables `onUnhandledRequest: "error"`, so any
 * request issued by tests must be matched by either a default handler
 * here or a per-test override registered via `server.use(...)`.
 *
 * MSW is wired into the `unit` vitest project only — the integration
 * project's tests spin up in-process HTTP servers and fixture dev
 * servers, which don't mix well with the @mswjs/interceptors layer.
 * See the comment on the `integration` project in `vite.config.ts`.
 *
 * Tests register their own handlers locally via `server.use(...)`.
 */

/**
 * Loopback addresses are always passed through to the real network.
 *
 * Even unit tests routinely spin up small in-process HTTP servers
 * (e.g. middleware-rewrite proxy tests in `tests/shims.test.ts`,
 * static-asset 404 tests, JSX-in-JS rendering tests). Those tests bind
 * a Node `http.Server` on `127.0.0.1:<random>` and fetch it. Without
 * this passthrough, MSW's interceptor sees the loopback fetch, finds
 * no handler, and errors via `onUnhandledRequest: "error"`.
 *
 * `passthrough()` is the documented escape hatch: the request is
 * forwarded to the real network without buffering.
 */
// 127/8 + the unspecified `0.0.0.0` + IPv6 `::1` + the literal hostname
// "localhost". `0.0.0.0` is included defensively — Node servers that
// bind to "0.0.0.0" sometimes surface that exact host in URLs handed
// to fetch in tests. The IPv4 octets are loosely bounded to 1-3 digits
// — `URL.hostname` normalises real addresses and no test would
// construct an out-of-range octet, so the looser bound keeps the regex
// readable.
const LOOPBACK_URL_PATTERN =
  /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0(?:\.0){3}|\[?::1\]?)(?::\d+)?(?:\/|$)/;
const loopbackPassthrough = http.all(LOOPBACK_URL_PATTERN, () => passthrough());

export const handlers: RequestHandler[] = [loopbackPassthrough];
