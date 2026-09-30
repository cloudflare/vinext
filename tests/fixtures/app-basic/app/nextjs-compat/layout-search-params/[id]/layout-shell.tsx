"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    __vinextLayoutSearchParamsMountCount__?: number;
  }
}

function LayoutShellInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [mountCount, setMountCount] = useState(0);

  useEffect(() => {
    window.__vinextLayoutSearchParamsMountCount__ =
      (window.__vinextLayoutSearchParamsMountCount__ ?? 0) + 1;
    setMountCount(window.__vinextLayoutSearchParamsMountCount__);
  }, []);

  return (
    <div>
      <h1>Layout Search Params</h1>
      <div id="layout-count">{count}</div>
      <div id="layout-mount-count">{mountCount}</div>
      <button id="layout-increment" onClick={() => setCount((value) => value + 1)}>
        Increment layout state
      </button>
      <button id="layout-push" onClick={() => router.push("?foo=bar")}>
        Push foo=bar
      </button>
      <button id="layout-replace" onClick={() => router.replace("?foo=baz")}>
        Replace foo=baz
      </button>
      {children}
    </div>
  );
}

export const LayoutShell = React.memo(LayoutShellInner);
