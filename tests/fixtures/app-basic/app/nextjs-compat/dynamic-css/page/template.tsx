import type { ReactNode } from "react";
import TemplateFrame from "./template-frame";

export default function DynamicCssTemplate({ children }: { children: ReactNode }) {
  return <TemplateFrame>{children}</TemplateFrame>;
}
