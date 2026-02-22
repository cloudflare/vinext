// Force all pages to be dynamically rendered (no static pre-rendering).
// Without this, Next.js detects most pages as static and pre-renders them at
// build time — work that vinext doesn't do. This benchmark is designed to
// compare build/compilation speed, not static generation, so we opt out of
// pre-rendering to keep the comparison apples-to-apples.
export const dynamic = "force-dynamic";

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

