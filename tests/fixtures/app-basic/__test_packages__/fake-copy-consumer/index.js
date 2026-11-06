import { createElement, Fragment } from "react";
// This workspace package has its own copy of fake-copy-barrel (v2).
import { CopyLeaf, CopyLocal } from "fake-copy-barrel";

export function ConsumerCopy() {
  return createElement(
    Fragment,
    null,
    createElement(CopyLocal, { id: "consumer-copy-local" }),
    createElement(CopyLeaf, { id: "consumer-copy-leaf" }),
  );
}
