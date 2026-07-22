export function generateStaticParams() {
  return [{ lang: "en" }, { lang: "es" }];
}

export default function LangLayout({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}
