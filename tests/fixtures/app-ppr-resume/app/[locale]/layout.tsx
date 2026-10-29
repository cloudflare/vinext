import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { countServerWork } from "../../lib/counters";
import { ShellProbe } from "./shell-probe";

export async function generateStaticParams() {
  countServerWork("gsp-locale");
  return [{ locale: "en" }, { locale: "de" }];
}

async function getShellStamp() {
  "use cache";
  cacheLife("days");
  return new Date().toISOString();
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <html lang={locale}>
      <head>
        <title>PPR resume</title>
      </head>
      <body>
        <header>
          <p id="locale">{locale}</p>
          <p id="shell-stamp">{await getShellStamp()}</p>
          <ShellProbe />
        </header>
        <Suspense fallback={<p id="page-loading">Loading page…</p>}>{children}</Suspense>
      </body>
    </html>
  );
}
