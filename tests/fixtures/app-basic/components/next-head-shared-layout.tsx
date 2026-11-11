"use client";

import Head from "next/head";
import { useEffect, useState, type ReactNode } from "react";

// A client layout shared by both routers (issue #4589). Next.js applies its
// next/head tags in the Pages Router and ignores them in the App Router.
export function NextHeadSharedLayout({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <>
      <Head>
        <title>next/head title</title>
        <meta name="description" content="next/head description" />
        <meta name="next-head-client" content="applied" />
      </Head>
      {mounted ? <p id="next-head-layout-mounted">mounted</p> : null}
      {children}
    </>
  );
}
