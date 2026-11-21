export default function PinRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body id="pin-root">{children}</body>
    </html>
  );
}
