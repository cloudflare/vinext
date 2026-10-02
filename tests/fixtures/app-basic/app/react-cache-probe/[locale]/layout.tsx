import type { ReactNode } from "react";
import { getRequestLocale, setRequestLocale } from "../request-locale";

export function generateStaticParams() {
  return [{ locale: "en" }, { locale: "es" }];
}

async function LocaleNav() {
  return <nav data-testid="react-cache-probe-nav">{await getRequestLocale()}</nav>;
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <section>
      <LocaleNav />
      {children}
    </section>
  );
}
