export const dynamicParams = false;

export default async function EveryParamCachePage({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) {
  const { lang, slug } = await params;
  return (
    <main>
      <h1 id="every-param-cache">
        complete: {lang}/{slug}
      </h1>
      <p id="rendered-at">{Date.now()}</p>
    </main>
  );
}
