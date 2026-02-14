import { Boundary } from '#/ui/boundary';

export default function Loading() {
  return (
    <Boundary label="loading.tsx" animateRerendering={false}>
      <div className="flex flex-col gap-8">
        {/* Product Details Skeleton */}
        <Boundary
          label="<ProductDetails> (static)"
          size="small"
          color="blue"
          animateRerendering={false}
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <div className="h-20 w-20 animate-pulse rounded-lg bg-gray-800" />
              <div className="flex flex-col gap-2">
                <div className="h-8 w-48 animate-pulse rounded bg-gray-800" />
                <div className="h-4 w-32 animate-pulse rounded bg-gray-800" />
              </div>
            </div>
          </div>
        </Boundary>

        {/* Recommendations Skeleton */}
        <Boundary
          label="<Recommendations>"
          size="small"
          color="blue"
          animateRerendering={false}
        >
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-gray-300">
              Recommendations
            </h2>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-48 animate-pulse rounded-lg bg-gray-800"
                />
              ))}
            </div>
          </div>
        </Boundary>
      </div>
    </Boundary>
  );
}
