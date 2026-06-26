export type PagesClientAssets = {
  clientEntry?: string;
  appBootstrapPreinitModules?: string[];
  ssrManifest?: Record<string, string[]>;
  lazyChunks?: string[];
  dynamicPreloads?: Record<string, string[]>;
};

let pagesClientAssets: PagesClientAssets = {};

export function setPagesClientAssets(assets: PagesClientAssets | undefined): void {
  pagesClientAssets = assets ?? {};
}

export function getPagesClientAssets(): PagesClientAssets {
  return pagesClientAssets;
}
