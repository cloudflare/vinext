"use client";

import localFont from "next/font/local";

const font = localFont({ src: "./font-d.woff2" });

export function ClientFont({ children }: { children: React.ReactNode }) {
  return <div className={font.className}>{children}</div>;
}
