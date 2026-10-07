"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

export function Greeting() {
  const t = useTranslations("HomePage");
  const [count, setCount] = useState(0);
  return (
    <>
      <p data-testid="client-greeting">{t("title")}</p>
      <button data-testid="translation-counter" onClick={() => setCount(count + 1)}>{count}</button>
    </>
  );
}
