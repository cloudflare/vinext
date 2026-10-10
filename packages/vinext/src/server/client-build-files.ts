import { decodePathParams } from "./normalize-path.js";

/**
 * Return the client build file a request pathname names, or null. Client
 * build files are the files the client build emits outside `_next/static`
 * (see `collectClientBuildFiles`). Workers Static Assets serves them before
 * the Worker unless the Worker runs first, so servers handle them before
 * middleware and routing.
 *
 * The list holds decoded file names, so a percent-encoded pathname is also
 * matched in its segment-wise decoded form.
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
  if (clientBuildFiles.has(filePath)) return filePath;
  if (!filePath.includes("%")) return null;
  const decodedFilePath = decodePathParams(filePath);
  return clientBuildFiles.has(decodedFilePath) ? decodedFilePath : null;
}
