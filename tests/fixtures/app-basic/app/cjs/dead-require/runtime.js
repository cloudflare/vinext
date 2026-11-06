// The only require() sits in the branch that the server's
// process.env.NEXT_RUNTIME define makes dead. As in Next.js, it is never
// loaded. Next.js's fixture requires "this should fail" there. This one
// requires a module that resolves, because the dev dependency optimizer runs
// vite-plugin-commonjs's own pre-bundle hook, which still hoists the call.
// Based on Next.js: test/e2e/instrumentation-hook/with-node-page/instrumentation.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/instrumentation-hook/with-node-page/instrumentation.js
export function runtimeName() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return "edge";
  } else if (process.env.NEXT_RUNTIME === "nodejs") {
    return "nodejs";
  } else {
    require("./never-loaded.js");
  }
}
