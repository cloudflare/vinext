import { appendFile } from "node:fs/promises";
import { VERSION } from "./version";

// The test reads this file to learn which build executed an action, because the
// response body disappears when the page reloads.
export async function recordActionRun(name: string): Promise<void> {
  await appendFile("action-runs.log", `${name}:${VERSION}\n`);
}
