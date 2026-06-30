import type { ReactNode } from "react";
import SharedLayoutStyles from "./shared-layout-styles";
import server from "./server.module.css";
import Inner from "./inner";

export default function DynamicCssPageLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SharedLayoutStyles />
      <p id="dynamic-css-server" className={`dynamic-css-global ${server.class}`}>
        Hello Server
      </p>
      <Inner />
      {children}
    </>
  );
}
