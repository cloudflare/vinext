// Inline type-only specifier import (biome style). Popular scaffolds
// (create-t3-app) emit this form; it must be fully elided even though this
// fixture's tsconfig enables `verbatimModuleSyntax`.
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Type-Only Imports Fixture",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
