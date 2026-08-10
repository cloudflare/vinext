import { getTranslations, setRequestLocale } from "next-intl/server";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Mirrors nodejs.org: the page establishes next-intl's request locale and
  // the parent layout consumes it while resolving the provider messages.
  // https://github.com/nodejs/nodejs.org/commit/5eace3f956c10da92880be7ce16e942bbcb47ff7
  setRequestLocale(locale);
  const t = await getTranslations("HomePage");

  return (
    <div>
      <h1 data-testid="title">{t("title")}</h1>
      <p data-testid="description">{t("description")}</p>
    </div>
  );
}
