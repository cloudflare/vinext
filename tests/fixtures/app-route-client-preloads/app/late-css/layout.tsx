import type { ReactNode } from "react";
import "./late-layout.css";

export default function LateCssLayout({ children }: { children: ReactNode }) {
  return <section className="late-layout">{children}</section>;
}
