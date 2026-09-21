export type AssetCrossOrigin = "" | "anonymous" | "use-credentials";

export type PagesClientAssets = {
  clientEntry?: string;
  appBootstrapPreinitModules?: string[];
  ssrManifest?: Record<string, string[]>;
  lazyChunks?: string[];
  dynamicPreloads?: Record<string, string[]>;
  /** next.config crossOrigin, defaulting to anonymous for Vite's CORS-fetched assets. */
  crossOrigin?: AssetCrossOrigin;
};

let pagesClientAssets: PagesClientAssets = {};

export function setPagesClientAssets(assets: PagesClientAssets | undefined): void {
  pagesClientAssets = assets ?? {};
}

export function getPagesClientAssets(): PagesClientAssets {
  return pagesClientAssets;
}
