"use client";

import { label } from "../../../packages/undeclared-tla/index.js";

export function Label() {
  return <p data-testid="side-effects-label">{label}</p>;
}
