import "./globals.css";
import Link from "next/link";

const navigation = [
  { title: "Introduction", href: "/" },
  { title: "Another Page", href: "/another" },
  {
    title: "Advanced",
    href: "/advanced",
    children: [{ title: "Satori", href: "/advanced/satori" }],
  },
];

const navbarLinks = [
  { title: "About", href: "/about" },
  {
    title: "Contact",
    href: "https://twitter.com/shuding_",
    external: true,
  },
];

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        {navigation.map((item) => (
          <div key={item.href}>
            <Link href={item.href} className="sidebar-link">
              {item.title}
            </Link>
            {item.children?.map((child) => (
              <Link
                key={child.href}
                href={child.href}
                className="sidebar-link nested"
              >
                {child.title}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function Navbar() {
  return (
    <nav className="navbar">
      <Link href="/" className="navbar-logo">
        My Project
      </Link>
      <ul className="navbar-links">
        {navbarLinks.map((link) => (
          <li key={link.href}>
            {link.external ? (
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {link.title} ↗
              </a>
            ) : (
              <Link href={link.href}>{link.title}</Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Nextra Docs Template</title>
      </head>
      <body>
        <Navbar />
        <div className="docs-layout">
          <Sidebar />
          <main className="docs-content">{children}</main>
        </div>
        <footer className="footer">Nextra Docs Template</footer>
      </body>
    </html>
  );
}
