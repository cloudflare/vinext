"use client";

import { useState } from "react";
import Script from "next/script";

declare global {
  interface Window {
    __vinextAppBeforeReadyCalls?: number;
  }
}

function BeforeInteractiveScript(): React.ReactElement {
  return (
    <Script
      id="app-before-ready"
      src="/beforeinteractive-ready.js"
      strategy="beforeInteractive"
      onReady={() => {
        window.__vinextAppBeforeReadyCalls = (window.__vinextAppBeforeReadyCalls ?? 0) + 1;
      }}
    />
  );
}

export function BeforeInteractiveReady(): React.ReactElement {
  const [mounted, setMounted] = useState(true);

  return (
    <>
      {mounted ? <BeforeInteractiveScript /> : null}
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle script
      </button>
    </>
  );
}
