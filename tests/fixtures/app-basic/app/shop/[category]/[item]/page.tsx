export async function generateStaticParams({ params }: { params: { category: string } }) {
  // Simulate parent-dependent params generation
  const items: Record<string, string[]> = {
    electronics: ["phone", "laptop"],
    clothing: ["shirt", "pants"],
  };
  return (items[params.category] ?? ["default"]).map((item) => ({ item }));
}

export default async function ItemPage({
  params,
}: {
  params: Promise<{ category: string; item: string }>;
}) {
  const { category, item } = await params;
  return (
    <div>
      <h1>
        Item: {item} in {category}
      </h1>
    </div>
  );
}
