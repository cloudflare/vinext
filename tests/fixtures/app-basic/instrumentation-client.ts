const instrumentationWindow = window as Window & {
  __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number;
  __INSTRUMENTATION_CLIENT_UPDATED?: boolean;
  __ROUTER_TRANSITION_EVENTS?: unknown[];
};

// Read by app-router/instrumentation-client-transition-events.spec.ts.
instrumentationWindow.__ROUTER_TRANSITION_EVENTS = [];

instrumentationWindow.__INSTRUMENTATION_CLIENT_EXECUTED_AT = performance.now();

if (window.location.pathname.startsWith("/instrumentation-client")) {
  const start = performance.now();
  while (performance.now() - start < 20) {
    // Intentionally block for 20ms to verify slow-execution logging in dev.
  }
}

export function onRouterTransitionStart(
  href: string,
  navigationType: string,
  event: unknown,
): void {
  const pathname = new URL(href, window.location.href).pathname;
  console.log(`[Router Transition Start] [${navigationType}] ${pathname}`);
  instrumentationWindow.__ROUTER_TRANSITION_EVENTS?.push({ url: pathname, navigationType, event });
}
