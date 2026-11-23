import { lang } from "next/root-params";

const locales = ["lv", "en"];

export function generateStaticParams() {
  return locales.map((l) => ({ lang: l }));
}

export default async function Layout({ children }: { children: React.ReactNode }) {
  const l = await lang();
  if (!l || !locales.includes(l)) throw new Error(`unknown locale ${l}`);
  return (
    <html lang={l}>
      <body>{children}</body>
    </html>
  );
}
