import { cookies } from "next/headers";

export const revalidate = 60;

export function generateStaticParams() {
  return [{ slug: "built-static" }];
}

export default async function TraceAutoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cookieStore = await cookies();
  return (
    <main>
      Traced auto-dynamic App Page: {slug} ({cookieStore.get("fixture")?.value ?? "none"})
    </main>
  );
}
