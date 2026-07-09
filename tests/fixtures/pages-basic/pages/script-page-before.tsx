import { useState } from "react";
import Script from "next/script";

export default function ScriptPageBefore() {
  const [mounted, setMounted] = useState(true);

  return (
    <main>
      <h1>Page Before Interactive</h1>
      {mounted ? (
        <Script id="page-before" src="/page-before-script.js" strategy="beforeInteractive" />
      ) : null}
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle page script
      </button>
    </main>
  );
}
