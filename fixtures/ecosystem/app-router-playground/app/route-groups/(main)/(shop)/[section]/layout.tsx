import { notFound } from 'next/navigation';
import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Tabs } from '#/ui/tabs';

export default async function Layout({
  params,
  children,
}: {
  children: React.ReactNode;
  params: Promise<{ section: string }>;
}) {
  const { section: sectionSlug } = await params;
  const section = db.section.find({ where: { slug: sectionSlug } });
  if (!section) {
    notFound();
  }

  const demo = db.demo.find({ where: { slug: 'route-groups' } });
  const categories = db.category.findMany({ where: { section: section?.id } });

  return (
    <Boundary
      label="(main)/(shop)/[section]/layout.tsx"
      className="flex flex-col gap-9"
    >
      <Tabs
        basePath={`/${demo.slug}/${section.slug}`}
        items={[
          { text: 'All' },
          ...categories.map((x) => ({ text: x.name, slug: x.slug })),
        ]}
      />

      <div>{children}</div>
    </Boundary>
  );
}
