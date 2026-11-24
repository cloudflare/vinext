import localFont from "next/font/local";

const fontNavigationA = localFont({ src: "../../script-nonce/with-next-font/font.woff2" });

export default function FontNavigationALayout({ children }: { children: React.ReactNode }) {
  return <div className={fontNavigationA.className}>{children}</div>;
}
