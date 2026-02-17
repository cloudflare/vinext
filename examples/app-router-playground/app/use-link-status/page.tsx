import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { ProductCard } from '#/ui/product-card';
import { connection } from 'next/server';

export default async function Page() {
  // DEMO:
  // This page would normally be prerendered at build time because it doesn't use dynamic APIs.
  // That means the loading state wouldn't show. To force one:
  // We indicate that we require a user Request before continuing:
  await connection();

  const products = db.product.findMany({ limit: 9 });

  return (
    <Boundary label="page.tsx">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-gray-300">
          All{' '}
          <span className="font-mono tracking-tighter text-gray-600">
            ({products.length})
          </span>
        </h1>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </div>
    </Boundary>
  );
}
