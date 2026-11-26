import localFont from "next/font/local";

const font = localFont({ src: "./font-y.woff2" });

export default function ModalY() {
  return <h2 className={font.className}>Modal Y</h2>;
}
