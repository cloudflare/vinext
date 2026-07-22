export default function ClientCacheLayout({
  breadcrumbs,
  children,
}: {
  breadcrumbs: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div id="client-cache-breadcrumbs">{breadcrumbs}</div>
      {children}
    </section>
  );
}
