import { env } from "cloudflare:workers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body data-env={String(typeof env)}>{children}</body>
    </html>
  );
}
