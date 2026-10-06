import { cookies } from "next/headers";

export async function generateStaticParams() {
  return [{ slug: "listed" }];
}

// Every path but the listed one and the static-unlisted control reads a
// cookie, so its render is dynamic.
export default async function GeneratedCookiesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (slug !== "listed" && slug !== "static-unlisted") await cookies();

  return (
    <main>
      <h1>
        <code>/generated-cookies/{slug}</code>
      </h1>
      <p>
        Render ID: <code data-testid="generated-cookies-render-id">{crypto.randomUUID()}</code>
      </p>
    </main>
  );
}
