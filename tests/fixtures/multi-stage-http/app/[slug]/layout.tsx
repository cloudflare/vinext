export function generateStaticParams() {
  return [{ slug: "en" }];
}

export default function LocaleLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
