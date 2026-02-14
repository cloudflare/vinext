import ContextClickCounter from '#/app/context/context-click-counter';
import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { ProductCard } from '#/ui/product-card';

export default function Page() {
  const products = db.product.findMany({ limit: 9 });

  return (
    <Boundary label="page.tsx (Server Environment)">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-gray-300">
          All{' '}
          <span className="font-mono tracking-tighter text-gray-600">
            ({products.length})
          </span>
        </h1>

        <ContextClickCounter />

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
