// ESM instrumentationClientInject module, like Next.js'
// test/e2e/instrumentation-client-hook/inject/inject-a.js. It only logs and
// throws once a spec opts in, so other specs see no extra console output.
export function onRouterTransitionStart(href, navigationType) {
  if (!window.__VINEXT_THROW_INJECTED_HOOK) return;
  const pathname = new URL(href, window.location.href).pathname;
  console.log(`[Injected Transition Start] [${navigationType}] ${pathname} throws`);
  throw new Error("injected transition hook failed");
}
