// Ported from Next.js: test/e2e/instrumentation-hook/with-async-node-app-route/instrumentation.js
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/instrumentation-hook/with-async-node-app-route/instrumentation.js
// The compile-time NEXT_RUNTIME constant makes the last branch unreachable, so
// the missing module must never be resolved.
export async function register() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (process.env.NEXT_RUNTIME === "edge") {
    globalThis.instrumentationFinished = "edge";
  } else if (process.env.NEXT_RUNTIME === "nodejs") {
    globalThis.instrumentationFinished = "nodejs";
  } else {
    await require("this should fail");
  }
}
