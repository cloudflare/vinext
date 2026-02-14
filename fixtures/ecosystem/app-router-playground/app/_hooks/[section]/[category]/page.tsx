import { HooksClient } from '#/app/_hooks/_components/router-context';
import db from '#/lib/db';
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
    <div className="space-y-9">
      <h1 className="text-xl font-semibold text-gray-300">{category.name}</h1>

      <HooksClient />
    </div>
  );
}
