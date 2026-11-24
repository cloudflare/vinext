import localFont from "next/font/local";

const font = localFont({ src: "./font-gnf.woff2" });

// Renders route-miss 404s on its own, without the root layout.
export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body className={font.className}>
        <h1>Not found</h1>
      </body>
    </html>
  );
}
