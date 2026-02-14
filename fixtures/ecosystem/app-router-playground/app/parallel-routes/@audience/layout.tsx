import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Tabs } from '#/ui/tabs';

export default function Layout({ children }: { children: React.ReactNode }) {
  const demo = db.demo.find({ where: { slug: 'parallel-routes' } });

  return (
    <Boundary
      label="@audience/layout.tsx"
      size="small"
      className="flex flex-col gap-6"
    >
      <Tabs
        basePath={`/${demo.slug}`}
        items={[
          { text: 'Home' },
          { text: 'Demographics', slug: 'demographics' },
          { text: 'Subscribers', slug: 'subscribers' },
        ]}
      />

      {children}
    </Boundary>
  );
}
