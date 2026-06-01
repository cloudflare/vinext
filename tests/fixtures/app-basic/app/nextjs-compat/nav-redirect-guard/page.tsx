"use client";

import { redirect, usePathname } from "next/navigation";

export default function Page() {
  const pathname = usePathname();
  const authed = false;

  if (!authed && pathname !== "/nextjs-compat/nav-redirect-guard/login") {
    redirect("/nextjs-compat/nav-redirect-guard/login");
  }

  return <h1 id="redirect-guard-page">Protected Page</h1>;
}
