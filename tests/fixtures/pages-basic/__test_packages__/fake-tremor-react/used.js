import { createElement } from "react";

export function DefaultUsed({ id }) {
  return createElement(
    "span",
    {
      "data-testid": id,
      "data-unused-loaded": String(globalThis.__fakeTremorUnusedLoaded === true),
    },
    "default-used",
  );
}
