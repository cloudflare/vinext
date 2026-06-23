import { Suspense, type ReactNode } from "react";
import { cookies } from "next/headers";

async function getLocaleConfig(locale: string) {
  "use cache";
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { locale, home: `Home (${locale})`, blog: `Blog (${locale})` };
}

async function LocaleInfo({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const config = await getLocaleConfig(locale);
  return (
    <header id="locale-header">
      <strong>Locale: {config.locale}</strong>
      <span id="translations">
        {" "}
        {config.home} | {config.blog}
      </span>
    </header>
  );
}

async function UserInfo() {
  const cookieStore = await cookies();
  return <div id="user-info">User: {cookieStore.get("user")?.value ?? "anonymous"}</div>;
}

export function generateStaticParams() {
  return [{ locale: "en" }, { locale: "fr" }];
}

export default function RootLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  return (
    <html>
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: "40px auto",
          maxWidth: 760,
          padding: "0 24px",
        }}
      >
        <h1 id="static-header">Vinext PPR impact demo</h1>
        <p>
          This route mirrors Next.js&apos;s root-param fallback case. Vinext currently renders
          unknown paths normally until request-time fallback-shell resume is implemented.
        </p>
        <Suspense fallback={<div id="locale-loading">Loading locale...</div>}>
          <LocaleInfo params={params} />
        </Suspense>
        <Suspense fallback={<div id="user-loading">Loading user...</div>}>
          <UserInfo />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
