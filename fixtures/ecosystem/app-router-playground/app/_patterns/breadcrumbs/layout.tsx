import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Tabs } from '#/ui/tabs';
import React from 'react';

// export function generateMetadata() {
//   const demo = db.demo.find({ where: { slug: 'breadcrumbs' } });
//   return {
//     title: demo.name,
//     openGraph: {
//       title: demo.name,
//       images: [`/api/og?title=${demo.name}`],
//     },
//   };
// }

export default async function Layout({
  children,
  breadcrumbs,
}: {
  children: React.ReactNode;
  breadcrumbs: React.ReactNode;
}) {
  const categories = db.category.findMany();

  return (
    <div className="space-y-9">
      <Boundary label={['@breadcrumbs']}>{breadcrumbs}</Boundary>

      <div className="flex justify-between">
        <Tabs
          basePath="/patterns/breadcrumbs"
          items={[
            { text: 'Home' },
            ...categories.map((x) => ({ text: x.name, slug: x.slug })),
          ]}
        />
      </div>

      <Boundary>{children}</Boundary>
    </div>
  );
}
