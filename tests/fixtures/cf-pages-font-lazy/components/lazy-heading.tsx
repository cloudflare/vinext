import localFont from "next/font/local";

const font = localFont({ src: "../fonts/font-lazy.woff2" });

export default function LazyHeading() {
  return <h1 className={font.className}>Lazy heading</h1>;
}
