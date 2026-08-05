import { existsSync } from "node:fs";
import path from "pathslash";

export type PublicDirConflictOptions = {
  root: string;
  publicDir: string | null;
  assetsDir: string;
};

const PUBLIC_NEXT_CONFLICT_ERROR =
  "You can not have a '_next' folder inside of your public folder. " +
  "This conflicts with the internal '/_next' route. " +
  "https://nextjs.org/docs/messages/public-next-folder-conflict";

export function assertNoPublicDirAssetConflict({
  root,
  publicDir,
  assetsDir,
}: PublicDirConflictOptions): void {
  if (!publicDir) return;

  const resolvedPublicDir = path.resolve(root, publicDir);
  const publicNextDir = path.join(resolvedPublicDir, "_next");

  if (existsSync(publicNextDir)) {
    throw new Error(PUBLIC_NEXT_CONFLICT_ERROR);
  }

  if (!assetsDir) return;

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
