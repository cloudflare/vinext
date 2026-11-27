"use client";

import { ViewTransition } from "react";

export function VtBoundary({ name, children }: { name: string; children: React.ReactNode }) {
  return <ViewTransition key={name}>{children}</ViewTransition>;
}
