import type { ReactNode } from "react";
// Imports a value back from `_app`, as layouts reading an `_app` context do.
import { APP_TAGLINE } from "../pages/_app";

export function AppFrame({ children }: { children: ReactNode }) {
  return <main data-tagline={APP_TAGLINE}>{children}</main>;
}
