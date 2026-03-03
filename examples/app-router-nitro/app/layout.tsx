import { Inter, Geist_Mono } from "next/font/google";
import Link from "next/link";
import type { Metadata, Viewport } from "next";

const inter = Inter({ subsets: ["latin"], weight: ["400", "700"] });
const mono = Geist_Mono({ variable: "--font-mono" });

// Static metadata on root layout with title template
export const metadata: Metadata = {
  title: {
    default: "vinext + nitro",
    template: "%s | vinext + nitro",
  },
  description: "A vinext app deployed with nitro showcasing Next.js features",
  keywords: ["vinext", "nitro", "react", "vite"],
  openGraph: {
    siteName: "vinext + nitro",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111111" },
  ],
};

const globalStyles = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #fafafa; --fg: #111; --muted: #666; --border: #e5e5e5;
    --accent: #0070f3; --accent-hover: #0051a8;
    --card-bg: #fff; --card-shadow: 0 2px 8px rgba(0,0,0,0.08);
    --radius: 8px; --mono: var(--font-mono, monospace);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111; --fg: #ededed; --muted: #999; --border: #333;
      --accent: #3291ff; --accent-hover: #5ba8ff;
      --card-bg: #1a1a1a; --card-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
  }
  html { color-scheme: light dark; }
  body {
    font-family: inherit; background: var(--bg); color: var(--fg);
    line-height: 1.6; min-height: 100dvh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; color: var(--accent-hover); }
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.className} ${mono.variable}`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
      </head>
      <body>
        <header
          style={{
            borderBottom: "1px solid var(--border)",
            padding: "0.75rem 1.5rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--card-bg)",
          }}
        >
          <Link
            href="/"
            style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--fg)" }}
          >
            vinext + nitro
          </Link>
          <nav>
            <ul
              style={{
                display: "flex",
                gap: "1.25rem",
                listStyle: "none",
                fontSize: "0.9rem",
              }}
            >
              <li>
                <Link href="/">Home</Link>
              </li>
              <li>
                <Link href="/about">About</Link>
              </li>
              <li>
                <Link href="/blog/hello-world">Blog</Link>
              </li>
              <li>
                <Link href="/api/hello" prefetch={false}>
                  API
                </Link>
              </li>
            </ul>
          </nav>
        </header>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1.5rem" }}>
          {children}
        </div>
      </body>
    </html>
  );
}
