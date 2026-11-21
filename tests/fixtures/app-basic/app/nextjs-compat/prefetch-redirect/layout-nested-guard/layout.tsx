import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// The redirect comes from a component the layout renders, not the layout.
async function SessionGuard({ children }: { children: ReactNode }) {
  if (!(await cookies()).has("prefetch-redirect-session")) {
    redirect("/nextjs-compat/prefetch-redirect/target");
  }
  return children;
}

export default function LayoutNestedGuard({ children }: { children: ReactNode }) {
  return <SessionGuard>{children}</SessionGuard>;
}
