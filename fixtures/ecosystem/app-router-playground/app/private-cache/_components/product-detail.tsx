import { Boundary } from '#/ui/boundary';
import { SkeletonText } from '#/ui/skeleton';
import Image from 'next/image';

// Static - loads immediately
export async function ProductDetails({
  product,
}: {
  product: { id: string; name: string; image: string };
}) {
  return (
    <Boundary
      label="<ProductDetails> (static)"
      size="small"
      animateRerendering={false}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-8">
          <div className="overflow-hidden rounded-md bg-gray-900/50 p-12">
            <Image
              className="brightness-150"
              src={`/shop/${product.image}`}
              alt={product.name}
              quality={90}
              width={400}
              height={400}
            />
          </div>
          <div className="flex w-4/5 flex-col gap-[1.4em] text-sm text-gray-800">
            <SkeletonText
              count={1}
              minLength={3}
              maxLength={12}
              seed={product.id}
            />
            <SkeletonText
              count={2}
              minLength={26}
              maxLength={50}
              seed={product.id}
            />
            <SkeletonText
              count={1}
              minLength={12}
              maxLength={18}
              seed={product.id}
            />
          </div>
        </div>
      </div>
    </Boundary>
  );
}
