import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [tarballDirectory] = process.argv.slice(2);
if (!tarballDirectory) {
  throw new Error("Usage: configure-local-vinext-types.mjs <tarball-directory>");
}

const typesTarballs = (await readdir(tarballDirectory)).filter((entry) =>
  /^vinext-types-.*\.tgz$/.test(entry),
);
if (typesTarballs.length !== 1) {
  throw new Error(
    `Expected exactly one @vinext/types tarball in ${tarballDirectory}, found ${typesTarballs.length}`,
  );
}

const packageJsonPath = path.resolve("package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
packageJson.pnpm ??= {};
packageJson.pnpm.overrides ??= {};
packageJson.pnpm.overrides["@vinext/types"] = pathToFileURL(
  path.resolve(tarballDirectory, typesTarballs[0]),
).href;

await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
