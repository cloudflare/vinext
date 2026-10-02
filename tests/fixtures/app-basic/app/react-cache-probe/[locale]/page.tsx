import { getRequestLocale, setRequestLocale } from "../request-locale";

export const dynamicParams = false;

async function LocaleHeading() {
  return <h1 data-testid="react-cache-probe-page">{await getRequestLocale()}</h1>;
}

export default async function LocalePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LocaleHeading />;
}
