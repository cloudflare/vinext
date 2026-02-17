import db from '#/lib/db';
import { SkeletonCard } from '#/ui/skeleton-card';
import { notFound } from 'next/navigation';

export default async function Page({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category: categorySlug } = await params;
  const category = db.category.find({ where: { slug: categorySlug } });
  if (!category) {
    notFound();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-300">{category.name}</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
