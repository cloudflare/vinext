"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "vinext-static-export-count";

export default function BrowserStateDemo() {
  const [count, setCount] = useState(0);
  const [storageAvailable, setStorageAvailable] = useState(false);

  useEffect(() => {
    setStorageAvailable(true);
    setCount(Number(window.localStorage.getItem(STORAGE_KEY) ?? 0));
  }, []);

  function increment() {
    setCount((current) => {
      const next = current + 1;
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <div className="interactive-card">
      <p className="mono" data-testid="hydration-state">{storageAvailable ? "hydrated in browser" : "prerendered at build"}</p>
      <strong data-testid="count">{count}</strong>
      <button type="button" onClick={increment}>Store another observation</button>
      <small>The count is local to this browser. No server receives it.</small>
    </div>
  );
}
