"use client";

import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("HomePage");

  return (
    <div>
      <h1 data-testid="title">{t("title")}</h1>
      <p data-testid="description">{t("description")}</p>
    </div>
  );
}
