export const revalidate = 1;

export function generateStaticParams() {
  return [{ slug: "prerendered" }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <>
      <img src="/hero.png" fetchPriority="high" alt="" />
      <p id="page">{slug}</p>
      <p id="rendered-at">{Date.now()}</p>
    </>
  );
}
