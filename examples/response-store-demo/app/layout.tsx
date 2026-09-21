import "./styles.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Workers Cache demo — vinext</title>
      </head>
      <body>
        <nav className="deployment-nav" aria-label="Demo deployments">
          <span>Demo deployments</span>
          <a href="https://response-store-demo.vinext.workers.dev">Response Store</a>
          <a href="https://workers-cache.vinext.workers.dev">Workers Cache + KV</a>
          <a href="https://kv.vinext.workers.dev">KV only</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
