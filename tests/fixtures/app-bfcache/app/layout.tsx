import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "App BFCache",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
