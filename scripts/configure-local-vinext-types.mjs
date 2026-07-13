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
const typesTarballUrl = pathToFileURL(path.resolve(tarballDirectory, typesTarballs[0])).href;
packageJson.pnpm.overrides["@vinext/types"] = typesTarballUrl;

await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const workspacePath = path.resolve("pnpm-workspace.yaml");
let workspace = "";
try {
  workspace = await readFile(workspacePath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const overrideLine = `  "@vinext/types": ${JSON.stringify(typesTarballUrl)}`;
const lines = workspace.split(/\r?\n/);
const overridesIndex = lines.findIndex((line) => line === "overrides:");

if (overridesIndex === -1) {
  while (lines.at(-1) === "") lines.pop();
  if (lines.length > 0) lines.push("");
  lines.push("overrides:", overrideLine, "");
} else {
  let overridesEnd = overridesIndex + 1;
  while (overridesEnd < lines.length && !/^\S/.test(lines[overridesEnd])) {
    overridesEnd++;
  }
  const existingEntry = lines.findIndex(
    (line, index) =>
      index > overridesIndex && index < overridesEnd && /^  ["']?@vinext\/types["']?:/.test(line),
  );
  if (existingEntry === -1) lines.splice(overridesEnd, 0, overrideLine);
  else lines[existingEntry] = overrideLine;
}

await writeFile(workspacePath, lines.join("\n"));
