import type { Rolldown } from "vite";

// Vite/Rolldown dedupes assets by source content. Next.js webpack emits CSS
// url() dependencies as asset/resource modules, so distinct source files keep
// distinct output names even when their bytes are identical.
type BundleAsset = Rolldown.OutputAsset;
type BundleAssetSource = BundleAsset["source"];

type CssUrlAssetBundle = Rolldown.OutputBundle;

type RestoredCssUrlAsset = {
  readonly fileName: string;
  readonly source: BundleAssetSource;
};

type EmitRestoredCssUrlAsset = (asset: RestoredCssUrlAsset) => void;

type DedupedAssetRestoration = {
  readonly sourceFileName: string;
  readonly outputFileNames: readonly string[];
  nextOutputIndex: number;
};

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function basename(value: string): string {
  const normalized = toPosixPath(value);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function fileStem(fileName: string): string {
  const base = basename(fileName);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex <= 0 ? base : base.slice(0, dotIndex);
}

function getSourceName(asset: BundleAsset, index: number): string | null {
  const name = asset.names?.[index];
  if (name) return basename(name);

  const originalFileName = asset.originalFileNames?.[index];
  return originalFileName ? basename(originalFileName) : null;
}

function isCssFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".css");
}

function deriveSiblingAssetFileName(
  existingFileName: string,
  existingSourceName: string,
  siblingSourceName: string,
): string | null {
  const existingStem = fileStem(existingSourceName);
  const siblingStem = fileStem(siblingSourceName);
  if (!existingStem || !siblingStem) return null;

  const normalizedOutputName = toPosixPath(existingFileName);
  const slashIndex = normalizedOutputName.lastIndexOf("/");
  const outputDir = slashIndex === -1 ? "" : normalizedOutputName.slice(0, slashIndex + 1);
  const outputBase =
    slashIndex === -1 ? normalizedOutputName : normalizedOutputName.slice(slashIndex + 1);

  if (!outputBase.startsWith(existingStem)) return null;

  return `${outputDir}${siblingStem}${outputBase.slice(existingStem.length)}`;
}

function reserveBundleFileName(fileName: string, usedFileNames: Set<string>): string {
  if (!usedFileNames.has(fileName)) {
    usedFileNames.add(fileName);
    return fileName;
  }

  const dotIndex = fileName.lastIndexOf(".");
  const prefix = dotIndex === -1 ? fileName : fileName.slice(0, dotIndex);
  const suffix = dotIndex === -1 ? "" : fileName.slice(dotIndex);

  let index = 1;
  while (true) {
    const candidate = `${prefix}-${index}${suffix}`;
    if (!usedFileNames.has(candidate)) {
      usedFileNames.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function addSiblingAsset(
  usedFileNames: Set<string>,
  mergedAsset: BundleAsset,
  fileName: string,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): string {
  const reservedFileName = reserveBundleFileName(fileName, usedFileNames);
  emitRestoredAsset({ fileName: reservedFileName, source: mergedAsset.source });
  return reservedFileName;
}

function buildDedupedAssetRestorations(
  bundle: CssUrlAssetBundle,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): DedupedAssetRestoration[] {
  const usedFileNames = new Set(Object.keys(bundle));
  const restorations: DedupedAssetRestoration[] = [];

  for (const entry of Object.values(bundle)) {
    if (entry.type !== "asset") continue;
    if (isCssFileName(entry.fileName)) continue;

    const sourceCount = Math.max(entry.originalFileNames?.length ?? 0, entry.names?.length ?? 0);
    if (sourceCount < 2) continue;

    const firstSourceName = getSourceName(entry, 0);
    if (!firstSourceName) continue;

    const outputFileNames = [entry.fileName];
    let hasSiblingOutput = false;

    for (let index = 1; index < sourceCount; index += 1) {
      const sourceName = getSourceName(entry, index);
      if (!sourceName || sourceName === firstSourceName) {
        outputFileNames.push(entry.fileName);
        continue;
      }

      const siblingFileName = deriveSiblingAssetFileName(
        entry.fileName,
        firstSourceName,
        sourceName,
      );
      if (!siblingFileName) {
        outputFileNames.push(entry.fileName);
        continue;
      }

      const restoredFileName = addSiblingAsset(
        usedFileNames,
        entry,
        siblingFileName,
        emitRestoredAsset,
      );
      outputFileNames.push(restoredFileName);
      hasSiblingOutput = true;
    }

    if (hasSiblingOutput) {
      restorations.push({
        sourceFileName: entry.fileName,
        outputFileNames,
        nextOutputIndex: 0,
      });
    }
  }

  return restorations;
}

function replaceNextOccurrence(
  source: string,
  search: string,
  replacement: string,
  fromIndex: number,
): { source: string; nextIndex: number; replaced: boolean } {
  const index = source.indexOf(search, fromIndex);
  if (index === -1) {
    return { source, nextIndex: fromIndex, replaced: false };
  }

  return {
    source: source.slice(0, index) + replacement + source.slice(index + search.length),
    nextIndex: index + replacement.length,
    replaced: true,
  };
}

function restoreCssSourceReferences(
  source: string,
  restorations: DedupedAssetRestoration[],
): string {
  let nextSource = source;

  for (const restoration of restorations) {
    let nextIndex = 0;
    while (true) {
      const replacement =
        restoration.outputFileNames[restoration.nextOutputIndex] ?? restoration.sourceFileName;
      const result = replaceNextOccurrence(
        nextSource,
        restoration.sourceFileName,
        replacement,
        nextIndex,
      );
      if (!result.replaced) break;

      nextSource = result.source;
      nextIndex = result.nextIndex;
      restoration.nextOutputIndex += 1;
    }
  }

  return nextSource;
}

export function restoreDedupedCssAssetReferences(
  bundle: CssUrlAssetBundle,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): void {
  const restorations = buildDedupedAssetRestorations(bundle, emitRestoredAsset);
  if (restorations.length === 0) return;

  for (const entry of Object.values(bundle)) {
    if (entry.type !== "asset") continue;
    if (!isCssFileName(entry.fileName)) continue;
    if (typeof entry.source !== "string") continue;

    entry.source = restoreCssSourceReferences(entry.source, restorations);
  }
}
