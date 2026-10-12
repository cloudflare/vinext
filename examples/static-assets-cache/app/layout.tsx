import type { ReactNode } from "react";
import Link from "next/link";
import { RenderSource } from "./render-source";

export const metadata = {
  title: "vinext Static Assets cache",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link> | <Link href="/about">About</Link> |{" "}
          <Link href="/dynamic">Dynamic</Link>
        </nav>
        <main>{children}</main>
        <RenderSource />
      </body>
    </html>
  );
}
