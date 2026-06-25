import Link from "next/link";

export default function MetadataIconsLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/manual-icon.svg" data-manual-icon="" />
        <link rel="apple-touch-icon" href="/manual-apple-icon.png" data-manual-icon="" />
      </head>
      <body>
        <nav>
          <Link id="metadata-icons-heart" href="/heart">
            Heart
          </Link>
          <Link id="metadata-icons-star" href="/star">
            Star
          </Link>
          <Link id="metadata-icons-none" href="/none">
            None
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
