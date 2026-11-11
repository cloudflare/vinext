import type { ReactNode } from "react";
import { Providers } from "./providers";

// No Suspense or loading boundary anywhere: a first request must still render
// every client component in full (issue #256).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
