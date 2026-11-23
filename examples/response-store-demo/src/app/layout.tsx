// The proxy.ts variant of this demo, built with VINEXT_RESPONSE_STORE_PROXY=1.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
