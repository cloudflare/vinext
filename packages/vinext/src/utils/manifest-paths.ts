export function normalizeManifestFile(file: string): string {
  return file.startsWith("/") ? file.slice(1) : file;
}

export function manifestFileWithBase(file: string, base: string): string {
  const normalizedFile = normalizeManifestFile(file);
  if (!base || base === "/") return normalizedFile;

  // Vite's SSR manifest stores base-prefixed paths without a leading slash,
  // e.g. "docs/assets/app.js" for base "/docs/".
  const normalizedBase = normalizeManifestFile(base).replace(/\/+$/, "");
  if (!normalizedBase) return normalizedFile;
  if (normalizedFile.startsWith(normalizedBase + "/")) return normalizedFile;
  return normalizedBase + "/" + normalizedFile;
}

export function manifestFilesWithBase(files: string[], base: string): string[] {
  return files.map((file) => manifestFileWithBase(file, base));
}
