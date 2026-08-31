"use client";

import { moduleUrl } from "module-identity-dependency";

export function ModuleUrl() {
  return <p suppressHydrationWarning>Module URL: {moduleUrl}</p>;
}
