import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import Link from "next/link";

declare global {
  interface Window {
    __popBlocked?: number;
  }
}

export default function BeforePopStateTest() {
  const router = useRouter();
  const [blocking, setBlocking] = useState(false);
  const [popAttempts, setPopAttempts] = useState(0);

  useEffect(() => {
    if (blocking) {
      router.beforePopState(() => {
        // Track blocked attempts on the window for cross-page access
        window.__popBlocked = (window.__popBlocked || 0) + 1;
        setPopAttempts((prev) => prev + 1);
        return false; // block navigation
      });
    } else {
      router.beforePopState(() => true); // allow navigation
    }
  }, [blocking, router]);

  return (
    <div>
      <h1>Before Pop State Test</h1>
      <Link href="/about" data-testid="link-about">
        Go to About
      </Link>
      <button data-testid="toggle-blocking" onClick={() => setBlocking(!blocking)}>
        {blocking ? "Blocking: ON" : "Blocking: OFF"}
      </button>
      <button data-testid="enable-blocking" onClick={() => setBlocking(true)}>
        Enable Blocking
      </button>
      <div data-testid="pop-attempts">{popAttempts}</div>
      <div data-testid="current-path">{router.asPath}</div>
    </div>
  );
}
