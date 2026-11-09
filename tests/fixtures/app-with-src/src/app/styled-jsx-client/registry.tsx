"use client";

// Next.js's documented App Router setup for styled-jsx server rendering.
// Ported from Next.js: test/e2e/app-dir/use-server-inserted-html/app/root-style-registry.js
import { useServerInsertedHTML } from "next/navigation";
import { useState, type ReactNode } from "react";
import { StyleRegistry, createStyleRegistry } from "styled-jsx";

export default function StyledJsxRegistry({ children }: { children: ReactNode }) {
  const [jsxStyleRegistry] = useState(() => createStyleRegistry());

  useServerInsertedHTML(() => {
    const styles = jsxStyleRegistry.styles();
    jsxStyleRegistry.flush();
    return <>{styles}</>;
  });

  return <StyleRegistry registry={jsxStyleRegistry}>{children}</StyleRegistry>;
}
