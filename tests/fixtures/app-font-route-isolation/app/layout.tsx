import localFont from "next/font/local";

const font = localFont({ src: "./font-root.woff2" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={font.className}>{children}</body>
    </html>
  );
}
