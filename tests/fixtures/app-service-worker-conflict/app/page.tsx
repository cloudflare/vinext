"use client";
import { useEffect } from "react";

// Two different workers at the same (default) scope, which must fail the build.
export default function Page() {
  useEffect(() => {
    void navigator.serviceWorker.register(new URL("../lib/pwa-a", import.meta.url));
    void navigator.serviceWorker.register(new URL("../lib/pwa-b", import.meta.url));
  }, []);
  return <p>multiple service workers</p>;
}
