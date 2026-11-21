export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}

export function generateStaticParams() {
  return [{ tenant: "a" }, { tenant: "b" }, { tenant: "c" }];
}
