import { createElement } from "react";

export function NodeFirstUsed({ id }) {
  return createElement(
    "span",
    {
      "data-testid": id,
      "data-unused-loaded": String(globalThis.__fakeNodeFirstUnusedLoaded === true),
    },
    "node-first-used",
  );
}
