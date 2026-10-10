/**
 * Return the URL pathname of the client build file a request pathname names,
 * or null. Client build files are the files the client build emits outside
 * `_next/static` (see `collectClientBuildFiles`). Workers Static Assets serves
 * them before the Worker unless the Worker runs first, so servers handle them
 * before middleware and routing.
 *
 * `pathname` is the raw request pathname. The list holds file names, so each
 * segment is decoded exactly once to match; a segment that decodes to a `/`
 * names no file. The result is segment-encoded, so a server that decodes it
 * once gets the file name back.
 */
export function resolveClientBuildFile(
  pathname: string,
  basePath: string,
  clientBuildFiles: ReadonlySet<string>,
): string | null {
  if (clientBuildFiles.size === 0) return null;
  let filePath = pathname;
  if (basePath) {
    if (!pathname.startsWith(`${basePath}/`)) return null;
    filePath = pathname.slice(basePath.length);
  }
  if (filePath.includes("%")) {
    let segments: string[];
    try {
      segments = filePath.split("/").map(decodeURIComponent);
    } catch {
      return null;
    }
    if (segments.some((segment) => segment.includes("/"))) return null;
    filePath = segments.join("/");
  }
  if (!clientBuildFiles.has(filePath)) return null;
  return filePath.split("/").map(encodeURIComponent).join("/");
}
