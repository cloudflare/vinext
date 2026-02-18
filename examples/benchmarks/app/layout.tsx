import "./styles.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>vinext Benchmarks</title>
        <meta
          name="description"
          content="Performance benchmarks for vinext vs Next.js, tracked over time."
        />
      </head>
      <body className="min-h-screen bg-gray-50 text-gray-900">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <a href="/" className="text-lg font-semibold tracking-tight">
              vinext benchmarks
            </a>
            <nav className="flex gap-4 text-sm text-gray-500">
              <a href="/" className="hover:text-gray-900">
                Dashboard
              </a>
              <a
                href="https://github.com/cloudflare/vinext"
                className="hover:text-gray-900"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
