"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { s } from "../_styles.js";

// next/dynamic — client-only component with loading fallback
const DynamicClock = dynamic(() => import("./clock.js"), {
  loading: () => <p>Loading clock...</p>,
  ssr: false,
});

export function Counter() {
  const [count, setCount] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <span data-testid="count" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
          {count}
        </span>
        <button data-testid="increment" onClick={() => setCount((c) => c + 1)} style={s.btnOutline}>
          + Increment
        </button>
      </div>

      {/* next/dynamic — lazy-loaded client-only clock */}
      <DynamicClock />

      {/* usePathname() + useSearchParams() */}
      <div style={s.mono}>
        <p data-testid="pathname">pathname: {pathname}</p>
        <p data-testid="search-params">
          searchParams: {searchParams.toString() || "(none)"}
        </p>
      </div>

      {/* useRouter() — programmatic navigation */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button data-testid="nav-about" onClick={() => router.push("/about")} style={s.btnOutline}>
          router.push(/about)
        </button>
        <button data-testid="nav-back" onClick={() => router.back()} style={s.btnOutline}>
          router.back()
        </button>
        <button data-testid="nav-refresh" onClick={() => router.refresh()} style={s.btnOutline}>
          router.refresh()
        </button>
      </div>
    </div>
  );
}
