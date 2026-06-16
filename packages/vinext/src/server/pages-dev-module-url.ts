import path from "node:path";

function normalizeBase(base: string): string {
  if (!base || base === "/") return "/";
  return `/${base.replace(/^\/+|\/+$/g, "")}/`;
}

function encodeModulePath(modulePath: string): string {
  return encodeURI(modulePath)
    .replace(/%5B/gi, "[")
    .replace(/%5D/gi, "]")
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");
}

export function createPagesDevModuleUrl(
  viteRoot: string,
  moduleFilePath: string,
  viteBase: string,
): string {
  const pathImpl = /^[A-Za-z]:[\\/]/.test(viteRoot) ? path.win32 : path;
  const relativePath = pathImpl.relative(viteRoot, moduleFilePath).replace(/\\/g, "/");
  return normalizeBase(viteBase) + encodeModulePath(relativePath);
}
