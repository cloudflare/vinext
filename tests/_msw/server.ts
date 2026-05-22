import { FetchInterceptor } from "@mswjs/interceptors/fetch";
import { SetupServerApi } from "msw/node";
import { handlers } from "./handlers.js";

/**
 * The MSW server instance for this vitest worker.
 *
 * `setupFiles` runs once per worker before any test code, so each worker gets
 * its own `server`. The vitest `integration` project runs file-serially, and
 * the `unit` project's tests rely on `server.resetHandlers()` between tests
 * (registered in `setup.ts`) to keep handler state isolated.
 *
 * We instantiate `SetupServerApi` directly with ONLY the `FetchInterceptor`,
 * rather than calling `setupServer()` (which also installs the
 * `ClientRequestInterceptor`). The latter monkey-patches `globalThis.Headers`
 * and `globalThis.Request` to record raw headers on a hidden symbol, and that
 * machinery leaks original-source headers across `new Request(req, { headers })`
 * copy-construction — surfacing as e.g. `new Headers(req.headers)` returning
 * headers that the new Request explicitly stripped. We only need
 * `globalThis.fetch` interception in this suite (no `node:http` callers), so
 * dropping the ClientRequestInterceptor avoids that side-effect entirely.
 *
 * TODO(msw-3): `SetupServerApi` is `@deprecated` in MSW 2.14.6 in favour of the
 * `defineNetwork` API that MSW 3 standardises around. Migrate when we bump to
 * MSW 3 — the FetchInterceptor-only customisation will need to be expressed
 * through `defineNetwork`'s interceptor configuration instead of constructing
 * `SetupServerApi` directly.
 */
export const server = new SetupServerApi(handlers, [new FetchInterceptor()]);
