"use client";

import localFont from "next/font/local";

// The font file is a public one named by a variable: vinext:local-fonts turns a
// literal relative `src` into an asset import that it adds above "use client",
// which would make this module a server component.
const src = "/font-d.woff2";
const font = localFont({ src });

export function ClientFont({ children }: { children: React.ReactNode }) {
  return <div className={font.className}>{children}</div>;
}
