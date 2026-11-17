// Like antd's ES build: a deep, extensionless import into a dependency without
// an `exports` map, which only a bundler can follow.
import omit from "rc-util/es/omit";
import { createElement } from "react";
export default function Button({ id }) {
  return createElement("b", { "data-testid": id }, omit("antd-button"));
}
