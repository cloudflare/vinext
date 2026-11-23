import localFont from "next/font/local";

const font = localFont({ src: "./font-x.woff2" });

export default function ModalX() {
  return <h2 className={font.className}>Modal X</h2>;
}
