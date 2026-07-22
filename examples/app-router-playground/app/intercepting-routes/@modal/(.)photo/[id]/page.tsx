import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { XMarkIcon } from '@heroicons/react/24/solid';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = db.product.find({ where: { id } });
  if (!product) {
    notFound();
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <Boundary
        label="@modal/(.)photo/[id]/page.tsx"
        color="cyan"
        kind="solid"
        animateRerendering={false}
        className="pointer-events-auto flex w-full max-w-3xl flex-col gap-6 rounded-2xl bg-gray-950"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="text-sm uppercase tracking-[0.2em] text-cyan-300">
              Intercepted in modal
            </div>
            <h2 className="text-2xl font-semibold text-white">{product.name}</h2>
          </div>

          <Link
            href="/intercepting-routes"
            className="rounded-full border border-gray-800 p-2 text-gray-400 hover:border-gray-700 hover:text-white"
            aria-label="Close modal"
          >
            <XMarkIcon className="size-5" />
          </Link>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,16rem)_1fr]">
          <div className="overflow-hidden rounded-2xl bg-gray-900/60 p-6">
            <Image
              src={`/shop/${product.image}`}
              alt={product.name}
              width={320}
              height={320}
              className="mx-auto brightness-150"
            />
          </div>

          <div className="flex flex-col gap-4">
            <p className="text-sm leading-6 text-gray-400">
              The browser URL is already pointing at the product detail page, but
              the source gallery stays mounted underneath because the navigation
              was intercepted by the parallel slot.
            </p>
            <div className="font-mono text-sm text-cyan-300">
              {`$${product.price.toFixed(2)}`}
            </div>
            <div className="text-xs text-gray-500">
              Refresh this URL to see the standalone detail page instead.
            </div>
          </div>
        </div>
      </Boundary>
    </div>
  );
}
