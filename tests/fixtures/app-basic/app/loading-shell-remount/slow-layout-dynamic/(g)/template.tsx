import type { ReactNode } from "react";

// Keyed by the route group and the [id] segment below it.
export default function Template({ children }: { children: ReactNode }) {
  return <div data-template>{children}</div>;
}
