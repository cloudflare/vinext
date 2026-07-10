"use client";

import Script from "next/script";

export default function HeadInsertionThemeScript({ theme }: { theme: string }) {
  return (
    <Script
      id="head-insertion-theme"
      strategy="beforeInteractive"
      dangerouslySetInnerHTML={{
        __html: `self.__headInsertionTheme = ${JSON.stringify(theme)};`,
      }}
    />
  );
}
