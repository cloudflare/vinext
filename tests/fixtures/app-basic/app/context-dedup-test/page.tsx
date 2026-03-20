"use client";

import { useTheme } from "fake-context-lib";

export default function ContextDedupPage() {
  const theme = useTheme();
  return (
    <div>
      <h1>Context Dedup Test</h1>
      <p data-testid="theme-value">Theme: {theme ?? "NOT_FOUND"}</p>
    </div>
  );
}
