const instrumentationWindow = window as Window & {
  __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number;
};

instrumentationWindow.__INSTRUMENTATION_CLIENT_EXECUTED_AT = performance.now();
