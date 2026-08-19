/** Normalize a URL pathname before route matching without decoding segments. */
export function normalizePath(pathname: string): string {
  if (
    pathname === "/" ||
    (pathname.length > 1 &&
      pathname[0] === "/" &&
      !pathname.includes("//") &&
      !pathname.includes("/./") &&
      !pathname.includes("/../") &&
      !pathname.endsWith("/.") &&
      !pathname.endsWith("/.."))
  ) {
    return pathname;
  }

  const segments = pathname.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return "/" + resolved.join("/");
}
