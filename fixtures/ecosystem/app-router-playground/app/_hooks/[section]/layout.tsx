import { LayoutHooks } from '#/app/_hooks/_components/router-context-layout';
import db from '#/lib/db';
import { ClickCounter } from '#/ui/click-counter';
import { Tabs } from '#/ui/tabs';
import { notFound } from 'next/navigation';

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ section: string }>;
}) {
  const { section: sectionSlug } = await params;
  const section = db.section.find({ where: { slug: sectionSlug } });
  if (!section) {
    notFound();
  }

  const categories = db.category.findMany({ where: { section: section.id } });

  return (
    <div className="space-y-9">
      <div className="flex justify-between">
        <Tabs
          basePath={`/hooks/${section.slug}`}
          items={[
            { text: 'All' },
            ...categories.map((x) => ({ text: x.name, slug: x.slug })),
          ]}
        />

        <div className="self-start">
          <ClickCounter />
        </div>
      </div>

      <LayoutHooks />

      <div>{children}</div>
    </div>
  );
}
