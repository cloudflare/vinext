/**
 * Stands in for a route module that reads request APIs at module scope — the
 * app pattern that turns lazy `import()` hydration into a cross-request leak.
 * ESM evaluates this once per process, so whatever it captures here is what
 * every later request to the route would be served.
 */
import { cookies } from "../../packages/vinext/src/shims/headers.js";

export const moduleScopeCookieAccess: string = await cookies().then(
  (jar) => `read:${jar.get("session")?.value ?? "none"}`,
  () => "rejected-no-request-context",
);
