import type { ReactNode } from "react";

export const dynamic = "force-static";

export default function ForceStaticClientPageLayout({ children }: { children: ReactNode }) {
  return children;
}
