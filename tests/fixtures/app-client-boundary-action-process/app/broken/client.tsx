"use client";

import { missing } from "./missing-module";

export function BrokenClientBoundary() {
  return <p>{missing}</p>;
}
