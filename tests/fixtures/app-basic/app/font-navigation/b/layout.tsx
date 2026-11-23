import localFont from "next/font/local";

const fontNavigationB = localFont({ src: "../../script-nonce/with-next-font/font.woff2" });

export default function FontNavigationBLayout({ children }: { children: React.ReactNode }) {
  return <div className={fontNavigationB.className}>{children}</div>;
}
