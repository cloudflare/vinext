import { createElement } from "react";

export function CopyLeaf({ id }) {
  return createElement("span", { "data-testid": id }, "leaf-v2");
}
