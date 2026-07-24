/**
 * Bridge between instrumentation.page.ts and the /api/status route.
 *
 * The boot hook and API routes may evaluate in different module graphs (or
 * different processes under some dev servers), so process-global state is not
 * a reliable bridge on its own. A tmp-file fallback keeps the signal visible
 * across process boundaries; same-process reads hit the global first.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GLOBAL_KEY = "__atlas_boot_state__";

const stateFile = path.join(os.tmpdir(), "atlas-pages-router-complex-boot.json");

export const markBootHookCalled = (): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = true;
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ booted: true }), "utf-8");
  } catch {
    // best-effort — the global flag still covers same-process readers
  }
};

export const wasBootHookCalled = (): boolean => {
  if ((globalThis as Record<string, unknown>)[GLOBAL_KEY] === true) {
    return true;
  }
  try {
    return (
      (JSON.parse(fs.readFileSync(stateFile, "utf-8")) as { booted?: boolean })
        .booted === true
    );
  } catch {
    return false;
  }
};
