import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Greeting } from "../greeting";

type Props = { params: Promise<{ locale: string }> };

// The page sets the request locale for the layout's getMessages(), and
// generateMetadata() passes its locale explicitly, as next-intl documents.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "HomePage" });
  return { title: t("title") };
}

export default async function MetadataPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("HomePage");

  return (
    <div>
      <h1 data-testid="title">{t("title")}</h1>
      {/* Reads the messages the layout resolved. */}
      <Greeting />
    </div>
  );
}
