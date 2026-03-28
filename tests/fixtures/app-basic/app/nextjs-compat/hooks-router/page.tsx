"use client";
import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
export default function Page() {
  const router = useRouter();
  const pathname = usePathname();
  const [log, setLog] = useState<string[]>([]);
  return (
    <div>
      <h1 id="router-test-page">Router Test Page</h1>
      <p id="current-pathname">{pathname}</p>
      <p id="action-log">{JSON.stringify(log)}</p>
      <button
        id="push-btn"
        onClick={() => {
          router.push("/nextjs-compat/nav-redirect-result");
        }}
      >
        Push
      </button>
      <button
        id="replace-btn"
        onClick={() => {
          router.replace("/nextjs-compat/nav-redirect-result");
        }}
      >
        Replace
      </button>
      <button
        id="back-btn"
        onClick={() => {
          router.back();
        }}
      >
        Back
      </button>
      <button
        id="forward-btn"
        onClick={() => {
          router.forward();
        }}
      >
        Forward
      </button>
      <button
        id="refresh-btn"
        onClick={() => {
          router.refresh();
          setLog((prev) => [...prev, "refreshed"]);
        }}
      >
        Refresh
      </button>
      <button
        id="push-with-query-btn"
        onClick={() => {
          router.push("/nextjs-compat/hooks-router?test=value");
        }}
      >
        Push with Query
      </button>
    </div>
  );
}
