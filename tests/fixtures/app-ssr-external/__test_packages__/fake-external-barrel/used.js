import { createElement } from "react";

export function ExternalUsed({ id }) {
  return createElement(
    "span",
    {
      "data-testid": id,
      "data-unused-loaded": String(globalThis.__fakeExternalUnusedLoaded === true),
    },
    "external-used",
  );
}
