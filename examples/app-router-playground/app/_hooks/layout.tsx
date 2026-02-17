import { LayoutHooks } from '#/app/_hooks/_components/router-context-layout';
import db from '#/lib/db';
import { ClickCounter } from '#/ui/click-counter';
import { Tabs } from '#/ui/tabs';
import React from 'react';

// export function generateMetadata() {
//   const demo = db.demo.find({ where: { slug: 'hooks' } });

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
}: {
  children: React.ReactNode;
}) {
  const sections = db.section.findMany();

  return (
    <div className="space-y-9">
      <div className="flex justify-between">
        <Tabs
          basePath="/hooks"
          items={[
            { text: 'Home' },
            ...sections.map((x) => ({ text: x.name, slug: x.slug })),
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
