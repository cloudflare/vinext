"use client";

import { useLayoutEffect } from "react";
import { useRouter } from "next/navigation";

export default function LayoutNavigationPage() {
  const router = useRouter();
  useLayoutEffect(() => {
    router.push("#ready", { scroll: false });
  }, [router]);
  return <h1>Layout navigation</h1>;
}
