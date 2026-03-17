export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html className="root-layout-html">
      <body>{children}</body>
    </html>
  );
}
