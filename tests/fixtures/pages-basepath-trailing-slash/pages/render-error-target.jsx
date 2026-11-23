// Coverage: tests/e2e/pages-router-basepath/trailing-slash.spec.ts. Renders on
// the server and while hydrating its own document, but throws when a client
// navigation renders it, so the router must recover with a hard navigation.
export default function RenderErrorTarget() {
  if (typeof window !== "undefined" && window.__NEXT_HYDRATED === true) {
    throw new Error("render-error-target fails in client navigations");
  }
  return <h1 id="render-error-target">render error target</h1>;
}
