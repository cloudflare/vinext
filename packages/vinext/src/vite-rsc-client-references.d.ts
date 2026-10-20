declare module "virtual:vite-rsc/client-references" {
  const clientReferences: Record<string, unknown>;
  export default clientReferences;
  /** What each App Router route preloads before SSR; null in development. */
  export const routeClientReferences:
    | import("./server/app-client-reference-preloader.js").RouteClientReferences
    | null;
}
