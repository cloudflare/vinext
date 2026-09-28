"use client";

import { use } from "react";

let ready: Promise<string> | undefined;

export function SlowClient() {
  ready ??= new Promise((resolve) => setTimeout(() => resolve("slow-ready"), 100));
  return <span data-testid="slow-client">{use(ready)}</span>;
}
