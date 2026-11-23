// Unused by the app. Imports `./measure` statically and with `import()`, as
// libraries do for a helper they need at startup and reload on demand.
import { measure } from "./measure";

export function createClient() {
  return {
    measure,
    reload: () => import("./measure"),
  };
}
