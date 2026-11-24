export default async function ClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p id="intercept-source-params-club">Club: {slug}</p>;
}
