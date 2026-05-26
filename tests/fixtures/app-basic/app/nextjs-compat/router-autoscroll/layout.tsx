import type { ReactNode } from "react";
import { RouterAutoscrollControls } from "./router-controls";

export default function RouterAutoscrollLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <RouterAutoscrollControls />
      {children}
    </>
  );
}
