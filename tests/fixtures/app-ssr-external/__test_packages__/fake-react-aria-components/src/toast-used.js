import { createElement } from "react";

export function ToastUsed({ id }) {
  return createElement(
    "span",
    {
      "data-testid": id,
      "data-unused-loaded": String(globalThis.__fakeToastUnusedLoaded === true),
    },
    "toast-used",
  );
}
