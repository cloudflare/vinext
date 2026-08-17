/** Encode each pathname segment without encoding `/` separators. */
function encodePublicFilePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Precompute keys for both encoded requests and decoded proxy/dev variants. */
export function publicFilePathVariants(pathname: string): string[] {
  const encoded = encodePublicFilePath(pathname);
  return encoded === pathname ? [pathname] : [pathname, encoded];
}
