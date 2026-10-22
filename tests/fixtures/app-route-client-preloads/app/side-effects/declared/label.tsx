"use client";

import { label } from "../../../packages/declared-tla/index.js";

export function Label() {
  return <p data-testid="side-effects-label">{label}</p>;
}
