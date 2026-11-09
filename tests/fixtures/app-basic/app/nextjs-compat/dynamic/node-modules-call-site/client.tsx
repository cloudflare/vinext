"use client";

import { DynamicHost } from "fake-css-module-lib/dynamic-host.js";

// The next/dynamic() call site itself lives in a package (the fixture's `file:`
// test package, installed under node_modules), not in app code.
export function NodeModulesDynamicHost() {
  return <DynamicHost />;
}
