import { HooksClient } from '#/app/_hooks/_components/router-context';
import db from '#/lib/db';
import { notFound } from 'next/navigation';

export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section: sectionSlug } = await params;
  const section = db.section.find({ where: { slug: sectionSlug } });
  if (!section) {
    notFound();
  }

  return (
    <div className="space-y-9">
      <h1 className="text-xl font-semibold text-gray-300">
        All {section.name}
      </h1>

      <HooksClient />
    </div>
  );
}
