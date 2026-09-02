import fs from "node:fs";

export function readAppRouterEntrySource(): string {
  const sourceUrl = new URL("../packages/vinext/src/server/app-router-entry.ts", import.meta.url);
  if (fs.existsSync(sourceUrl)) return fs.readFileSync(sourceUrl, "utf-8");
  return fs.readFileSync(
    new URL("../packages/vinext/src/server/app-router-entry.js", import.meta.url),
    "utf-8",
  );
}

export function readPagesRouterEntrySource(): string {
  return readPagesRequestStageEntrySource();
}

export function readPagesSingleEntrySource(): string {
  const sourceUrl = new URL("../packages/vinext/src/server/pages-router-entry.ts", import.meta.url);
  if (fs.existsSync(sourceUrl)) return fs.readFileSync(sourceUrl, "utf-8");
  return fs.readFileSync(
    new URL("../packages/vinext/src/server/pages-router-entry.js", import.meta.url),
    "utf-8",
  );
}

function readPagesRequestStageEntrySource(): string {
  const sourceUrl = new URL(
    "../packages/vinext/src/server/pages-request-stage-entry.ts",
    import.meta.url,
  );
  if (fs.existsSync(sourceUrl)) return fs.readFileSync(sourceUrl, "utf-8");
  return fs.readFileSync(
    new URL("../packages/vinext/src/server/pages-request-stage-entry.js", import.meta.url),
    "utf-8",
  );
}

export function readPagesResponseStageEntrySource(): string {
  const sourceUrl = new URL(
    "../packages/vinext/src/server/pages-response-stage-entry.ts",
    import.meta.url,
  );
  if (fs.existsSync(sourceUrl)) return fs.readFileSync(sourceUrl, "utf-8");
  return fs.readFileSync(
    new URL("../packages/vinext/src/server/pages-response-stage-entry.js", import.meta.url),
    "utf-8",
  );
}
