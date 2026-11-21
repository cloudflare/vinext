export default function SiteRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body id="site-root">
        <header>1. Header</header>
        <main id="main">{children}</main>
        <footer>3. Footer</footer>
      </body>
    </html>
  );
}
