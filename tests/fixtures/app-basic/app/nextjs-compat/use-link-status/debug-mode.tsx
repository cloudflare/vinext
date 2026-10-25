"use client";

import { useSearchParams } from "next/navigation";

export default function DebugMode() {
  const searchParams = useSearchParams();
  if (searchParams.get("debug") !== "1") return null;
  return (
    <div data-testid="debug-mode">
      <h2>Debug Mode Enabled</h2>
    </div>
  );
}
