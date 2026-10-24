import { createElement } from "react";

export function BarrelLabel() {
  return createElement(
    "p",
    { "data-testid": "side-effect-free-barrel" },
    "Server-safe barrel export",
  );
}
