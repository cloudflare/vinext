import React from 'react';
import { Boundary } from '#/ui/boundary';
import { Tabs } from '#/ui/tabs';
import db from '#/lib/db';

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const demo = db.demo.find({ where: { slug: 'route-groups' } });
  const sections = db.section.findMany({ limit: 1 });

  return (
    <Boundary label="(main)/layout.tsx" className="flex flex-col gap-9">
      <Tabs
        basePath={`/${demo.slug}`}
        items={[
          { text: 'Home' },
          ...sections.map((x) => ({ text: x.name, slug: x.slug })),
          { text: 'Checkout', slug: 'checkout' },
          { text: 'Blog', slug: 'blog' },
        ]}
      />

      <div>{children}</div>
    </Boundary>
  );
}
