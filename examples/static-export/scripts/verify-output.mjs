import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/client/", import.meta.url));

const expected = new Map([
  ["index.html", "Static does not mean inert"],
  ["catalog/pocket-observatory/index.html", "Pocket Observatory"],
  ["catalog/tide-clock/index.html", "Tide Clock"],
  ["catalog/trail-journal/index.html", "Trail Journal"],
  ["docs/building/the-artifact/index.html", "Read the artifact"],
  ["docs/deployment/cloudflare/index.html", "Deploy without a server"],
  ["browser-state/index.html", "Interactivity survives the export"],
  ["search/index.html", "The browser owns the query string"],
  ["legacy/index.html", "Two routers, one static artifact"],
  ["products/atlas/index.html", "Atlas Field Kit"],
  ["products/lantern/index.html", "Low-light Lantern"],
  ["404.html", "This route was never in the map"],
  ["404/index.html", "This route was never in the map"],
  ["robots.txt", "User-agent: *"],
  ["icon.svg", "<svg"],
  ["island-grid.svg", "<svg"],
]);

const failures = [];
for (const [relativePath, marker] of expected) {
  const path = join(root, relativePath);
  try {
    await access(path);
    const contents = await readFile(path, "utf8");
    // React may insert text separators between adjacent JSX expressions.
    const comparable = relativePath.endsWith(".html")
      ? contents.replaceAll("<!-- -->", "")
      : contents;
    if (!comparable.includes(marker)) failures.push(`${relativePath} does not contain ${JSON.stringify(marker)}`);
  } catch {
    failures.push(`${relativePath} is missing`);
  }
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

const files = await listFiles(root);
for (const template of ["catalog/[slug]", "docs/[...slug]", "products/[id]"]) {
  if (files.some((file) => file.includes(template))) failures.push(`dynamic template leaked into output: ${template}`);
}

if (failures.length > 0) {
  console.error("Static export verification failed:\n" + failures.map((failure) => `  - ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Verified ${expected.size} representative files in dist/client (${files.length} files total).`);
