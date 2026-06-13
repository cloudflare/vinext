export default async function Page({ params }: { params: Promise<{ catchAll: string[] }> }) {
  const { catchAll } = await params;
  return <div id="root-catchall">Showcase Simple Page: {catchAll.join("/")}</div>;
}
