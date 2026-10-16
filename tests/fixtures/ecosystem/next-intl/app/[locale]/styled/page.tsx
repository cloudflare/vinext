import { getTranslations, setRequestLocale } from "next-intl/server";
import { Greeting } from "../greeting";
import styles from "./page.module.css";

type Props = { params: Promise<{ locale: string }> };

// Importing CSS makes @vitejs/plugin-rsc wrap this export in a synchronous
// component. The layout must still wait for the page to set the request
// locale before it resolves the provider messages.
export default async function StyledPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("HomePage");

  return (
    <div>
      <h1 data-testid="title" className={styles.title}>
        {t("title")}
      </h1>
      {/* Reads the messages the layout resolved. */}
      <Greeting />
    </div>
  );
}
