function normalizeManifestFile(file: string): string {
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

/**
 * Strip a `base` prefix that Vite applied twice: it bakes `base` into the
 * on-disk chunk fileName and then prepends it again in `ssr-manifest.json`,
 * yielding `docs/docs/_next/static/...` which 404s. Only an exact
 * `<base>/<base>/` prefix is collapsed; a single prefix is left untouched.
 */
export function collapseDuplicateBase(file: string, base: string): string {
  const normalizedFile = normalizeManifestFile(file);
  if (!base || base === "/") return normalizedFile;

  const normalizedBase = normalizeManifestFile(base).replace(/\/+$/, "");
  if (!normalizedBase) return normalizedFile;

  const doubledPrefix = `${normalizedBase}/${normalizedBase}/`;
  return normalizedFile.startsWith(doubledPrefix)
    ? normalizedFile.slice(normalizedBase.length + 1)
    : normalizedFile;
}
