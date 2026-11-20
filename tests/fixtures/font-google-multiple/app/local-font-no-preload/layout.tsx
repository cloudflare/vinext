import localFont from "next/font/local";

// `preload: false` keeps the file out of the font preloads, as in Next.js.
const noPreload = localFont({ src: "../local.woff2", preload: false });

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className={noPreload.className}>{children}</div>;
}
