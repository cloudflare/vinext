import type { ReactNode } from "react";
import { Providers } from "./providers";

// No Suspense or loading boundary anywhere: a client reference that is still
// loading must hold the shell, not fail it (issue #256).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
