import type { ReactNode } from "react";
import StyledJsxRegistry from "./registry";

export default function StyledJsxLayout({ children }: { children: ReactNode }) {
  return <StyledJsxRegistry>{children}</StyledJsxRegistry>;
}
