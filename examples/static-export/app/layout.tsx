import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Static by design",
    template: "%s · Static by design",
  },
  description: "A comprehensive vinext static export built for zero-runtime hosting.",
};

const navigation = [
  ["/", "Overview"],
  ["/catalog/pocket-observatory", "Generated routes"],
  ["/docs/building/the-artifact", "Catch-all docs"],
  ["/browser-state", "Client state"],
  ["/search?topic=constellations", "URL state"],
  ["/legacy", "Pages Router"],
] as const;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="site-header">
            <Link className="brand" href="/" aria-label="Static by design home">
              <span className="brand-mark" aria-hidden="true">✦</span>
              <span>Static by design</span>
            </Link>
            <nav aria-label="Primary navigation">
              {navigation.map(([href, label]) => (
                <Link href={href} key={href}>{label}</Link>
              ))}
            </nav>
          </header>
          <main>{children}</main>
          <footer>
            <p>Built once with vinext. Served as HTML, CSS, JavaScript, and RSC payloads.</p>
            <p className="mono">output: &quot;export&quot; → dist/client</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
