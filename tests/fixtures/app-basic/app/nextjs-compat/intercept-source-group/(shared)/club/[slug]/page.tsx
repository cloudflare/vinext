import Link from "next/link";

export default async function ClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <div id="intercept-source-group-club-page">
      <p>Club page</p>
      <Link href={`/nextjs-compat/intercept-source-group/club/${slug}/pics/1`}>Club pic 1</Link>
    </div>
  );
}
