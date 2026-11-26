"use client";
import { useEffect } from "react";

// Registers a compiled service worker, served by Nitro's static handler.
export default function ServiceWorkerPage() {
  useEffect(() => {
    void navigator.serviceWorker.register(new URL("../../lib/sw", import.meta.url));
  }, []);
  return <h1>Service worker</h1>;
}
