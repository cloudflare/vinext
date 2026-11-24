import Link from "next/link";

// A page below the owner, linking to a pic of another club.
export default async function DeepPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <div id="intercept-source-params-deep">
      <p>Deep: {slug}</p>
      <Link href="/nextjs-compat/intercept-source-params/club/acme/pics/1">Acme pic 1</Link>
    </div>
  );
}
