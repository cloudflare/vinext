import { createElement } from "react";

export function OrderUsed({ id }) {
  return createElement(
    "span",
    {
      "data-testid": id,
      "data-unused-loaded": String(globalThis.__fakeExportOrderUnusedLoaded === true),
    },
    "export-order-used",
  );
}
