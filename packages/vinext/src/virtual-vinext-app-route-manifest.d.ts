declare module "virtual:vinext-app-route-manifest" {
  const routeManifest:
    | import("./routing/browser-route-manifest.js").BrowserRouteManifestWire
    | null;
  export default routeManifest;
}
