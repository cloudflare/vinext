import { afterEach, describe, expect, it } from "vite-plus/test";
import { isolateServerReferenceLoads } from "../packages/vinext/src/server/server-reference-loader.js";
import { cookies, headersContextFromRequest } from "../packages/vinext/src/shims/headers.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";

const originalRequire = globalThis.__vite_rsc_server_require__;

afterEach(() => {
  globalThis.__vite_rsc_server_require__ = originalRequire;
});

function readSessionCookie(): Promise<string> {
  return cookies().then(
    (jar) => jar.get("session")?.value ?? "none",
    () => "no-request",
  );
}

describe("isolateServerReferenceLoads", () => {
  // React resolves some decoded server references only once the action
  // consumes them (promise arguments, encrypted closure captures), inside the
  // caller's request. Whatever the loader observes is what module-scope
  // cookies() would capture for every later caller.
  it("loads server references outside the request that resolves them", async () => {
    globalThis.__vite_rsc_server_require__ = () => readSessionCookie();
    isolateServerReferenceLoads();

    const request = new Request("https://example.com/", {
      headers: { cookie: "session=first-caller" },
    });
    const observed = await runWithRequestContext(
      createRequestContext({ headersContext: headersContextFromRequest(request) }),
      async () => ({
        live: await readSessionCookie(),
        load: await globalThis.__vite_rsc_server_require__!("/app/actions.ts"),
      }),
    );

    expect(observed).toEqual({ live: "first-caller", load: "no-request" });
  });

  it("wraps the loader once", () => {
    globalThis.__vite_rsc_server_require__ = (id) => id;
    isolateServerReferenceLoads();
    const wrapped = globalThis.__vite_rsc_server_require__;
    isolateServerReferenceLoads();

    expect(globalThis.__vite_rsc_server_require__).toBe(wrapped);
    expect(wrapped!("/app/actions.ts")).toBe("/app/actions.ts");
  });

  it("does nothing before plugin-rsc installs its loader", () => {
    globalThis.__vite_rsc_server_require__ = undefined;
    isolateServerReferenceLoads();

    expect(globalThis.__vite_rsc_server_require__).toBeUndefined();
  });
});
