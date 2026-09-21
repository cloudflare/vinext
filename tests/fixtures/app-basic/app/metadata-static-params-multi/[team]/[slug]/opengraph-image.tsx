export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "public" }];
}

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ team: string; slug: string }>;
}) {
  const { team, slug } = await params;
  return new Response(`TEAM:${team}:${slug}`, {
    headers: { "content-type": "text/plain" },
  });
}
