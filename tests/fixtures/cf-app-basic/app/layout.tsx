import { CacheLayoutCounter } from "./cache-layout-counter";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CacheLayoutCounter />
        {children}
      </body>
    </html>
  );
}
