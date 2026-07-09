import { useState } from "react";
import Script from "next/script";

declare global {
  interface Window {
    __vinextBeforeReadyCalls?: number;
  }
}

function BeforeInteractiveScript() {
  return (
    <Script
      id="before-ready"
      src="/dedupe-script.js?before=ready"
      onReady={() => {
        window.__vinextBeforeReadyCalls = (window.__vinextBeforeReadyCalls ?? 0) + 1;
      }}
    />
  );
}

export default function ScriptBeforeReadyPage() {
  const [mounted, setMounted] = useState(true);

  return (
    <main>
      <h1>Before Interactive Ready</h1>
      {mounted ? <BeforeInteractiveScript /> : null}
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle script
      </button>
    </main>
  );
}
