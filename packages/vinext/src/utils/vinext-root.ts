import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the root directory of the vinext package at runtime.
 *
 * Both the CLI pre-flight check (`cli.ts`) and the standalone output emitter
 * (`build/standalone.ts`) need to locate vinext's package root so they can
 * verify that `dist/` exists and copy vinext's runtime files into standalone
 * output.  Centralising the logic here ensures the two callers stay in sync.
 *
 * The resolution works for both the compiled output layout and for running
 * directly from source:
 *
 *   - Compiled layout:  this file lives at `dist/utils/vinext-root.js`
 *                       → two levels up (`../..`) is the package root.
 *   - Source layout:    this file lives at `src/utils/vinext-root.ts`
 *                       → two levels up (`../..`) is the package root.
 *
 * If an explicit root is provided (e.g. from a test fixture), it is returned
 * as-is after resolving to an absolute path.
 */
export function resolveVinextPackageRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // src/utils/vinext-root.ts  → ../..  → package root
  // dist/utils/vinext-root.js → ../..  → package root
  return path.resolve(currentDir, "..", "..");
}
