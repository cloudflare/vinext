import Link from "next/link";

export { generateMetadata } from "../heart/page";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const nextSlug = slug === "ae0qv10f" ? "n8eg563h" : "ae0qv10f";
  return (
    <Link
      id="metadata-icons-collision"
      href={`/metadata-icons-stream/${nextSlug}`}
      prefetch={false}
    >
      Change route with identical icons
    </Link>
  );
}
