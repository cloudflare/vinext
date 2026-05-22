import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server.js";

/**
 * Vitest setup file that boots the MSW server for every worker.
 *
 * `onUnhandledRequest: "error"` makes any unmocked external request fail
 * loudly — the whole point of moving away from ad-hoc `globalThis.fetch`
 * hijacking is that tests which forget to mock an outbound request fail
 * loudly instead of silently hitting the network (or worse, leaking
 * through a stale stub a previous test left behind).
 *
 * Loopback requests are passed through to the real network by the
 * default `loopbackPassthrough` handler in `handlers.ts`, so integration
 * tests that spin up in-process HTTP servers continue to work.
 */
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
