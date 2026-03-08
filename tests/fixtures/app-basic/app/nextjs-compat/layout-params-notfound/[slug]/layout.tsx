export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const { slug } = await params;

  return (
    <div id="layout-params-notfound-wrapper" data-slug={slug}>
      {children}
    </div>
  );
}
