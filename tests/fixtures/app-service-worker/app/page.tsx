"use client";
import { useEffect, useState } from "react";

// Registers one worker at the default scope (with options that must survive
// the rewrite) and one at a nested scope, read through a `const` binding.
const offlineOptions = { scope: "/offline/mode" };

export default function Page() {
  const [status, setStatus] = useState("pending");

  useEffect(() => {
    async function register() {
      await navigator.serviceWorker.register(new URL("../lib/pwa", import.meta.url), {
        updateViaCache: "none",
      });
      await navigator.serviceWorker.register(
        new URL("../lib/pwa-offline", import.meta.url),
        offlineOptions,
      );
      setStatus("registered");
    }
    register().catch((error: Error) => setStatus(`error: ${error.message}`));
  }, []);

  return <p id="sw-status">{status}</p>;
}
