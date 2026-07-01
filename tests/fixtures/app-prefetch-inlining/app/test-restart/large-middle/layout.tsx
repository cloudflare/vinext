import type { ReactNode } from "react";
import { NoInline } from "../../../components/no-inline";

export const prefetchSize = "large";

export default function LargeLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <NoInline />
      {children}
    </div>
  );
}
