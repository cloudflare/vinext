// CommonJS instrumentationClientInject module whose hook is installed after
// load, like Next.js' test/e2e/instrumentation-client-hook/inject/inject-late-hook.cjs.
const hooks = {};
module.exports = hooks;

window.__VINEXT_INSTALL_LATE_INSTRUMENTATION_HOOK = () => {
  hooks.onRouterTransitionStart = (href, navigationType, event) => {
    const pathname = new URL(href, window.location.href).pathname;
    // app-basic enables instrumentationClientRouterTransitionEvents.
    const eventKind = event === null ? "null" : typeof event.id === "string" ? "event" : "invalid";
    console.log(
      `[Injected Transition Start] [${navigationType}] ${pathname} late-hook ${eventKind}`,
    );
  };
};
