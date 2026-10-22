export type AssetCrossOrigin = "" | "anonymous" | "use-credentials";

export type PagesClientAssets = {
  clientEntry?: string;
  appBootstrapPreinitModules?: string[];
  appRouteManifestModule?: string;
  ssrManifest?: Record<string, string[]>;
  /**
   * Shared Pages chunk files (framework, vinext runtime, client entry) keyed on
   * chunk names from this client build, in the SSR-manifest key-space.
   */
  sharedChunks?: string[];
  cssGraph?: Record<string, { imports?: string[]; css?: string[] }>;
  lazyChunks?: string[];
  dynamicPreloads?: Record<string, string[]>;
  /** next.config crossOrigin, defaulting to anonymous for Vite's CORS-fetched assets. */
  crossOrigin?: AssetCrossOrigin;
  /** Client bundle files outside `_next/static`, as URL pathnames. */
  clientBuildFiles?: string[];
};

let pagesClientAssets: PagesClientAssets = {};

export function setPagesClientAssets(assets: PagesClientAssets | undefined): void {
  pagesClientAssets = assets ?? {};
}

export function getPagesClientAssets(): PagesClientAssets {
  return pagesClientAssets;
}
