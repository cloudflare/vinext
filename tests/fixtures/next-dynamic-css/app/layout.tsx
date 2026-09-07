import type { ReactNode } from "react";
import "./global3.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
