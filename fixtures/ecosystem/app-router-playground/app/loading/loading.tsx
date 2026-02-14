import { Boundary } from '#/ui/boundary';
import { ProductCardSkeleton } from '#/ui/product-card';

export default function Loading() {
  return (
    <Boundary label="loading.tsx">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-gray-600">All</h1>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <ProductCardSkeleton />
          <ProductCardSkeleton />
          <ProductCardSkeleton />
        </div>
      </div>
    </Boundary>
  );
}
