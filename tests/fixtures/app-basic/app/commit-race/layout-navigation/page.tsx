"use client";

import { useLayoutEffect } from "react";
import { useRouter } from "next/navigation";

export default function LayoutNavigationPage() {
  const router = useRouter();
  useLayoutEffect(() => {
    const method = new URL(window.location.href).searchParams.get("history");
    if (method === "pushState" || method === "replaceState") {
      window.scrollTo(0, 500);
      window.history[method](null, "", "#ready");
    } else {
      router.push("#ready", { scroll: false });
    }
  }, [router]);
  return (
    <section style={{ minHeight: 2000 }}>
      <h1>Layout navigation</h1>
    </section>
  );
}
