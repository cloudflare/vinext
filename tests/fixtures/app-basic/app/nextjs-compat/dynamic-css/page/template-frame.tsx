import type { ReactNode } from "react";
import "./template.css";
import inlineCss from "./query.css?inline";

export default function TemplateFrame({ children }: { children: ReactNode }) {
  return <div data-inline-css-length={inlineCss.length}>{children}</div>;
}
