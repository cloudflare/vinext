import localFont from "next/font/local";

const font = localFont({ src: "../fonts/font-a.woff2" });

export const getServerSideProps = () => ({ props: {} });

export default function Page() {
  return <h1 className={font.className}>Page A</h1>;
}
