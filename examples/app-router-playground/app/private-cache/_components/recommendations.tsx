import { Boundary } from '#/ui/boundary';
import db from '#/lib/db';

export async function getPersonalizedRecommendations(
  productId: string,
  sessionId: string,
) {
  // DEMO: Hardcoded delay to help showcase that the loading of the
  // recommendations is occurring only after the user has clicked the product
  // and it was not prefetched.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Create deterministic recommendations based on session + product
  const hash = (sessionId + productId).split('').reduce((acc, char) => {
    return char.charCodeAt(0) + ((acc << 5) - acc);
  }, 0);

  const allProducts = db.product.findMany({ limit: 9 });
  const count = (Math.abs(hash) % 2) + 2; // 2-3 recommendations
  const startIndex = Math.abs(hash) % (allProducts.length - count);

  return allProducts.slice(startIndex, startIndex + count);
}

export function RecommendationsSkeleton() {
  return (
    <Boundary
      label="<Recommendations> (Private Cacheable + Runtime Prefetch)"
      size="small"
      color="blue"
      animateRerendering={false}
    >
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-gray-300">Recommendations</h2>
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
  );
}
