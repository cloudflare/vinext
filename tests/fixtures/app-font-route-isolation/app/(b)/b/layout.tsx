import localFont from "next/font/local";

const font = localFont({ src: "./font-b.woff2" });

export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div className={font.className}>
      {children}
      {modal}
    </div>
  );
}
