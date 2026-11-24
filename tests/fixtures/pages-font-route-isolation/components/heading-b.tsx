import localFont from "next/font/local";

const font = localFont({ src: "../fonts/font-b.woff2" });

export function HeadingB() {
  return <h1 className={font.className}>Page B</h1>;
}
