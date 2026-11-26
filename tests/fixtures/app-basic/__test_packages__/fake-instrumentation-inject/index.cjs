// A CommonJS instrumentationClientInject package whose hook is installed after
// load. In dev, Vite serves it through the deps optimizer.
const hooks = {};
module.exports = hooks;

window.__VINEXT_INSTALL_LATE_PACKAGE_INSTRUMENTATION_HOOK = () => {
  hooks.onRouterTransitionStart = (href, navigationType) => {
    const pathname = new URL(href, window.location.href).pathname;
    console.log(`[Injected Transition Start] [${navigationType}] ${pathname} package-late-hook`);
  };
};
