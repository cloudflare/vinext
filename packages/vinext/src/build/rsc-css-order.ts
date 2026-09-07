import fs from "node:fs";

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

export function reorderClientReferenceCss(
  css: string[],
  clientManifest: ClientBuildManifest,
): string[] {
  const candidates = Object.keys(clientManifest)
    .map((key) => ({
      dependenciesFirst: collectChunkCss(clientManifest, key, true),
      ownFirst: collectChunkCss(clientManifest, key, false),
    }))
    .filter(({ ownFirst }) => ownFirst.length >= 2)
    .sort((a, b) => b.ownFirst.length - a.ownFirst.length);

  const reordered: string[] = [];
  for (let index = 0; index < css.length;) {
    const candidate = candidates.find(
      ({ ownFirst }) =>
        index + ownFirst.length <= css.length &&
        ownFirst.every((file, offset) => hrefMatchesFile(css[index + offset] ?? "", file)),
    );
    if (!candidate) {
      reordered.push(css[index]);
      index++;
      continue;
    }

    // Resolve against this exact segment rather than searching the whole CSS
    // list. That preserves base/asset prefixes and cannot cross-match another
    // client chunk whose file path happens to share a suffix.
    const hrefByFile = new Map(
      candidate.ownFirst.map((file, offset) => [file, css[index + offset]]),
    );
    reordered.push(...candidate.dependenciesFirst.map((file) => hrefByFile.get(file)!));
    index += candidate.ownFirst.length;
  }
  return reordered;
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
    // Runtime asset URL placeholders are JavaScript expressions rather than
    // JSON. Preserve those manifests verbatim instead of corrupting the URLs.
    return source;
  }

  for (const deps of Object.values(manifest.clientReferenceDeps ?? {})) {
    deps.css = reorderClientReferenceCss(deps.css, clientManifest);
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
