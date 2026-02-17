'use cache';

import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { ProductCard } from '#/ui/product-card';

export default async function Page() {
  return (
    <Boundary label="page.tsx (Cacheable)">
      <ProductList />
    </Boundary>
  );
}

async function ProductList() {
  // DEMO: Add a delay to simulate a slow data request
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const products = db.product.findMany({ limit: 9 });

  return (
    <Boundary label="<ProductList>" size="small">
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
