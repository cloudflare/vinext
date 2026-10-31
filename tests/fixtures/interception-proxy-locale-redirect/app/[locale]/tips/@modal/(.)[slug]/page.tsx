export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <dialog open>{`INTERCEPTED-MODAL slug=${slug};`}</dialog>;
}
