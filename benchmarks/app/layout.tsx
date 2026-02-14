export const metadata = {
  title: { default: "Benchmark App", template: "%s | Benchmark" },
  description: "A realistic benchmark app for comparing Next.js and vinext",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ padding: "1rem", borderBottom: "1px solid #eee", display: "flex", gap: "1rem" }}>
          <a href="/">Home</a>
          <a href="/products">Products</a>
          <a href="/blog">Blog</a>
          <a href="/dashboard">Dashboard</a>
          <a href="/about">About</a>
          <a href="/docs">Docs</a>
          <a href="/settings">Settings</a>
        </nav>
        <main style={{ padding: "1rem" }}>{children}</main>
      </body>
    </html>
  );
}

