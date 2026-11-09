import { createElement } from "react";

export function CopyLocal({ id }) {
  return createElement("span", { "data-testid": id }, "barrel-v2");
}
