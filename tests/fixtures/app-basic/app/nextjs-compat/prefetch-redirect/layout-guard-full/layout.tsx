import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function LayoutGuard({ children }: { children: ReactNode }) {
  if (!(await cookies()).has("prefetch-redirect-session")) {
    redirect("/nextjs-compat/prefetch-redirect/target");
  }
  return children;
}
