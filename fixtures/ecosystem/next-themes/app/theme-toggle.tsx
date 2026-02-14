"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div data-testid="theme-loading">Loading theme...</div>;
  }

  return (
    <div>
      <p data-testid="current-theme">Current theme: {theme}</p>
      <p data-testid="resolved-theme">Resolved theme: {resolvedTheme}</p>
      <button
        data-testid="toggle-light"
        onClick={() => setTheme("light")}
      >
        Light
      </button>
      <button
        data-testid="toggle-dark"
        onClick={() => setTheme("dark")}
      >
        Dark
      </button>
      <button
        data-testid="toggle-system"
        onClick={() => setTheme("system")}
      >
        System
      </button>
    </div>
  );
}
