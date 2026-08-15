import { existsSync } from "node:fs";
import path from "pathslash";

export type PublicDirConflictOptions = {
  root: string;
  publicDir: string | null;
  assetsDir: string;
};

export type PublicNextRequestConflictOptions = Pick<
  PublicDirConflictOptions,
  "root" | "publicDir"
> & {
  basePath: string;
  requestUrl: string;
};

const PUBLIC_NEXT_CONFLICT_ERROR =
  "You can not have a '_next' folder inside of your public folder. " +
  "This conflicts with the internal '/_next' route. " +
  "https://nextjs.org/docs/messages/public-next-folder-conflict";

function assertNoPublicNextDir(root: string, publicDir: string | null): void {
  if (!publicDir) return;

  const publicNextDir = path.join(path.resolve(root, publicDir), "_next");
  if (existsSync(publicNextDir)) {
    throw new Error(PUBLIC_NEXT_CONFLICT_ERROR);
  }
}

export function assertNoPublicNextRequestConflict({
  root,
  publicDir,
  basePath,
  requestUrl,
}: PublicNextRequestConflictOptions): void {
  const internalOrigin = "http://vinext.invalid";
  // Concatenate origin-form targets so a leading `//` stays in the pathname
  // instead of being interpreted as a scheme-relative host. Next handles that
  // malformed shape through its repeated-slash redirect before this check.
  const parseTarget = requestUrl.startsWith("/") ? internalOrigin + requestUrl : requestUrl;
  let pathname = new URL(parseTarget, internalOrigin).pathname;
  if (basePath && (pathname === basePath || pathname.startsWith(basePath + "/"))) {
    pathname = pathname.slice(basePath.length) || "/";
  }

  if (pathname.startsWith("/_next")) {
    assertNoPublicNextDir(root, publicDir);
  }
}

export function assertNoPublicDirAssetConflict({
  root,
  publicDir,
  assetsDir,
}: PublicDirConflictOptions): void {
  assertNoPublicNextDir(root, publicDir);
  if (!publicDir || !assetsDir) return;

  const resolvedPublicDir = path.resolve(root, publicDir);

  // Next.js only reserves public/_next because it keeps emitted assets in
  // .next/static. Vinext writes path-prefixed assets into the client output,
  // where Vite also copies public files, so the configured output path must be
  // reserved as well to prevent the same namespace collision.
  const publicAssetsDir = path.resolve(resolvedPublicDir, assetsDir);
  const relativeAssetsDir = path.relative(resolvedPublicDir, publicAssetsDir);

  const isInsidePublicDir =
    relativeAssetsDir !== "" &&
    !relativeAssetsDir.startsWith("../") &&
    !path.isAbsolute(relativeAssetsDir);

  if (isInsidePublicDir && existsSync(publicAssetsDir)) {
    throw new Error(
      `[vinext] The public directory contains a path reserved for build assets: ` +
        `${relativeAssetsDir}`,
    );
  }
}
