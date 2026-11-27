export default async function ClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p id="intercept-grouped-children-page">Club page: {slug}</p>;
}
