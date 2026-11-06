import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Nav } from "./nav";

// next-intl's static rendering setup, as reported in
// https://github.com/cloudflare/vinext/issues/3671: the layout sets the request
// locale through a React cache() store, and a server component below it reads
// the store instead of falling back to headers().
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ locale: "en" }, { locale: "de" }];
}

export default async function StaticLocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <Nav />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
