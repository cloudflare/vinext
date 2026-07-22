import fs from "node:fs";

export function readPagesRouterEntrySource(): string {
  const sourceUrl = new URL("../packages/vinext/src/server/pages-router-entry.ts", import.meta.url);
  if (fs.existsSync(sourceUrl)) return fs.readFileSync(sourceUrl, "utf-8");
  return fs.readFileSync(
    new URL("../packages/vinext/src/server/pages-router-entry.js", import.meta.url),
    "utf-8",
  );
}
