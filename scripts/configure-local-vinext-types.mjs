import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [tarballDirectory] = process.argv.slice(2);
if (!tarballDirectory) {
  throw new Error("Usage: configure-local-vinext-types.mjs <tarball-directory>");
}

const tarballs = await readdir(tarballDirectory);
const typesTarballs = tarballs.filter((entry) => /^vinext-types-.*\.tgz$/.test(entry));
if (typesTarballs.length !== 1) {
  throw new Error(
    `Expected exactly one @vinext/types tarball in ${tarballDirectory}, found ${typesTarballs.length}`,
  );
}

const responseStoreTarballs = tarballs.filter((entry) =>
  /^vinext-workers-response-store-.*\.tgz$/.test(entry),
);
if (responseStoreTarballs.length > 1) {
  throw new Error(
    `Expected at most one @vinext/workers-response-store tarball in ${tarballDirectory}, found ${responseStoreTarballs.length}`,
  );
}

const packageJsonPath = path.resolve("package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
packageJson.pnpm ??= {};
packageJson.pnpm.overrides ??= {};
const typesTarballUrl = pathToFileURL(path.resolve(tarballDirectory, typesTarballs[0])).href;
const localOverrides = { "@vinext/types": typesTarballUrl };
if (responseStoreTarballs[0]) {
  localOverrides["@vinext/workers-response-store"] = pathToFileURL(
    path.resolve(tarballDirectory, responseStoreTarballs[0]),
  ).href;
}
Object.assign(packageJson.pnpm.overrides, localOverrides);

await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const workspacePath = path.resolve("pnpm-workspace.yaml");
let workspace = "";
try {
  workspace = await readFile(workspacePath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const lines = workspace.split(/\r?\n/);
const overridesIndex = lines.findIndex((line) => line === "overrides:");
const overrideLines = Object.entries(localOverrides).map(
  ([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
);

if (overridesIndex === -1) {
  while (lines.at(-1) === "") lines.pop();
  if (lines.length > 0) lines.push("");
  lines.push("overrides:", ...overrideLines, "");
} else {
  let overridesEnd = overridesIndex + 1;
  while (overridesEnd < lines.length && !/^\S/.test(lines[overridesEnd])) {
    overridesEnd++;
  }
  for (const [name, value] of Object.entries(localOverrides)) {
    const overrideLine = `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`;
    const existingEntry = lines.findIndex(
      (line, index) =>
        index > overridesIndex &&
        index < overridesEnd &&
        new RegExp(`^  ["']?${name.replace("/", "\\/")}["']?:`).test(line),
    );
    if (existingEntry === -1) {
      lines.splice(overridesEnd++, 0, overrideLine);
    } else {
      lines[existingEntry] = overrideLine;
    }
  }
}

await writeFile(workspacePath, lines.join("\n"));
