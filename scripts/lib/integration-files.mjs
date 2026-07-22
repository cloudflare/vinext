import { execSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

export function discoverIntegrationFiles() {
  let raw;
  try {
    raw = execSync("vp test list --project integration --filesOnly", {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch {
    throw new Error("Failed to run 'vp test list --project integration --filesOnly'");
  }

  const files = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const bracketed = trimmed.match(/^\[\w+\]\s+(.+)$/);
    if (bracketed) files.push(bracketed[1]);
    else if (/^tests\/.+\.test\.(ts|js|tsx|jsx)$/.test(trimmed)) files.push(trimmed);
  }
  return files.sort((a, b) => a.localeCompare(b));
}
