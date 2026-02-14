import { Breadcrumbs } from '#/app/_patterns/breadcrumbs/_components/breadcrumbs';

export default async function Page({
  params,
}: {
  params: Promise<{ all: string[] }>;
}) {
  const { all } = await params;

  // Note: you could fetch breadcrumb data based on params here
  // e.g. title, slug, children/siblings (for dropdowns)
  const items = [
    ...all.map((param, index) => ({
      text: param,
      // build cumulative path by joining all segments up to current index
      href: `/${all.slice(0, index + 1).join('/')}`,
    })),
  ];

  return <Breadcrumbs items={items} />;
}
