import { fileURLToPath } from "node:url";

/* A deliberately long block comment spanning multiple lines, the kind an
 * annotated dependency would carry, exceeding any bounded filter window
 * between the callee and the argument below. This exercises the unbounded
 * window in the transform filter. */
const __filename = fileURLToPath(import.meta.url);

export const modulePath = __filename;
