import Link from "next/link";

export default async function DynamicInterceptionRevalidatePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <div>
      <h1 id="dynamic-interception-revalidate-home">Dynamic Interception Revalidate</h1>
      <Link href={`/dynamic-interception-revalidate/${locale}/photos/1/view`}>To Photo</Link>
    </div>
  );
}
