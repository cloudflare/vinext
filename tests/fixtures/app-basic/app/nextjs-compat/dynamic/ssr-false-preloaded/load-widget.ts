// Cache the import so the dynamic() loader returns an already-settled promise
// after the hover preload. A fresh native import() of a loaded module still
// takes a few browser tasks to resolve in Vite (webpack and Turbopack resolve
// loaded chunks in microtasks), which this fixture keeps out of the test.
let widget: Promise<typeof import("./widget")> | undefined;

export const loadWidget = () =>
  (widget ??= import("./widget").then((mod) => {
    // Lets the e2e test wait until the preload has settled before it clicks.
    (window as { __ssrFalsePreloadedWidgetReady?: boolean }).__ssrFalsePreloadedWidgetReady = true;
    return mod;
  }));
