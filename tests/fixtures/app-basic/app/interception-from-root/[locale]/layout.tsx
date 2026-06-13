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
      <body>
        <p id="locale-label">Locale: {locale}</p>
        {children}
      </body>
    </html>
  );
}
