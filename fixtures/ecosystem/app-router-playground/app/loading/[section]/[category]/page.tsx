import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Boundary } from '#/ui/boundary';
import { ProductCard } from '#/ui/product-card';
import db from '#/lib/db';

export default async function Page({
  params,
}: {
  params: Promise<{ section: string; category: string }>;
}) {
  // DEMO:
  // This page would normally be prerendered at build time because it doesn't use dynamic APIs.
  // That means the loading state wouldn't show. To force one:
  // 1. We indicate that we require a user Request before continuing:
  await connection();
  // 2. Add an artificial delay to make the loading state more noticeable:
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const { category: categorySlug } = await params;
  const category = db.category.find({ where: { slug: categorySlug } });

  if (!category) {
    notFound();
  }

  const products = db.product.findMany({ where: { category: category.id } });

  return (
    <Boundary label="[section]/[category]/page.tsx">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-gray-300">
          All{' '}
          <span className="font-mono tracking-tighter text-gray-600">
            ({products.length})
          </span>
        </h1>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              animateEnter={true}
            />
          ))}
        </div>
      </div>
    </Boundary>
  );
}
