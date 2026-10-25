import { getTranslations } from "next-intl/server";

export async function Nav() {
  const t = await getTranslations("Navigation");
  return <nav data-testid="nav">{t("home")}</nav>;
}
