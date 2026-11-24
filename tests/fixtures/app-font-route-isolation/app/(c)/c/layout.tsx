import localFont from "next/font/local";

const font = localFont({ src: "./font-c.woff2" });

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className={font.className}>{children}</div>;
}
