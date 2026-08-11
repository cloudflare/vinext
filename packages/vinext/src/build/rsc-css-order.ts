import fs from "node:fs";

const APP_GLOBAL_CSS_ASSET = "/app-global-css-";
const EXPORT_DEFAULT_PREFIX = "export default ";

type AssetDeps = { css: string[]; js?: string[] };

type RscAssetsManifest = {
  clientReferenceDeps?: Record<string, AssetDeps>;
  serverResources?: Record<string, AssetDeps>;
};

type ClientBuildChunk = {
  css?: string[];
  imports?: string[];
};

type ClientBuildManifest = Record<string, ClientBuildChunk>;

function collectChunkCss(
  manifest: ClientBuildManifest,
  key: string,
  dependenciesFirst: boolean,
  css: string[] = [],
  seenCss = new Set<string>(),
  visited = new Set<string>(),
): string[] {
  if (visited.has(key)) return css;
  visited.add(key);
  const chunk = manifest[key];
  if (!chunk) return css;

  const addOwnCss = () => {
    for (const file of chunk.css ?? []) {
      if (seenCss.has(file)) continue;
      seenCss.add(file);
      css.push(file);
    }
  };
  const addImportedCss = () => {
    for (const importedKey of chunk.imports ?? []) {
      collectChunkCss(manifest, importedKey, dependenciesFirst, css, seenCss, visited);
    }
  };

  if (dependenciesFirst) {
    addImportedCss();
    addOwnCss();
  } else {
    addOwnCss();
    addImportedCss();
  }
  return css;
}

function hrefMatchesFile(href: string, file: string): boolean {
  const cleanHref = href.split(/[?#]/, 1)[0] ?? href;
  return cleanHref === file || cleanHref.endsWith(`/${file}`);
}

function reorderClientReferenceCss(css: string[], clientManifest: ClientBuildManifest): string[] {
  for (const key of Object.keys(clientManifest)) {
    const ownFirst = collectChunkCss(clientManifest, key, false);
    if (ownFirst.length < 2 || ownFirst.length > css.length) continue;
    if (!ownFirst.every((file, index) => hrefMatchesFile(css[index] ?? "", file))) continue;

    const dependenciesFirst = collectChunkCss(clientManifest, key, true);
    const reordered = dependenciesFirst.map(
      (file) => css.find((href) => hrefMatchesFile(href, file)) ?? file,
    );
    return [...reordered, ...css.slice(ownFirst.length)];
  }
  return css;
}

export function normalizeRscAssetsManifestCssOrderSource(
  source: string,
  clientManifest: ClientBuildManifest,
): string {
  if (!source.startsWith(EXPORT_DEFAULT_PREFIX)) return source;

  let manifest: RscAssetsManifest;
  try {
    manifest = JSON.parse(source.slice(EXPORT_DEFAULT_PREFIX.length)) as RscAssetsManifest;
  } catch {
    return source;
  }

  for (const deps of Object.values(manifest.clientReferenceDeps ?? {})) {
    deps.css = reorderClientReferenceCss(deps.css, clientManifest);
  }

  // plugin-rsc collects each RSC chunk's own CSS before the CSS of its
  // imports. Global stylesheets live in stable owner chunks, so put those
  // imported assets before route-local CSS modules while preserving the
  // relative order within both groups.
  for (const deps of Object.values(manifest.serverResources ?? {})) {
    const globalCss = deps.css.filter((href) => href.includes(APP_GLOBAL_CSS_ASSET));
    const otherCss = deps.css.filter((href) => !href.includes(APP_GLOBAL_CSS_ASSET));
    deps.css = [...globalCss, ...otherCss];
  }

  return `${EXPORT_DEFAULT_PREFIX}${JSON.stringify(manifest, null, 2)}`;
}

export function normalizeRscAssetsManifestCssOrder(
  manifestPath: string,
  clientManifestPath: string,
): boolean {
  if (!fs.existsSync(manifestPath) || !fs.existsSync(clientManifestPath)) return false;
  const source = fs.readFileSync(manifestPath, "utf8");
  const clientManifest = JSON.parse(
    fs.readFileSync(clientManifestPath, "utf8"),
  ) as ClientBuildManifest;
  const normalized = normalizeRscAssetsManifestCssOrderSource(source, clientManifest);
  if (normalized === source) return false;
  fs.writeFileSync(manifestPath, normalized);
  return true;
}
