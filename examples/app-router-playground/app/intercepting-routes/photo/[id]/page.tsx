import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { ChevronLeftIcon } from '@heroicons/react/24/solid';
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
    <Boundary label="photo/[id]/page.tsx" className="flex flex-col gap-6">
      <Link
        href="/intercepting-routes"
        className="inline-flex items-center gap-2 text-sm font-medium text-gray-400 hover:text-white"
      >
        <ChevronLeftIcon className="size-4" />
        Back to gallery
      </Link>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="overflow-hidden rounded-2xl bg-gray-900/60 p-8">
          <Image
            src={`/shop/${product.image}`}
            alt={product.name}
            width={400}
            height={400}
            className="mx-auto brightness-150"
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="text-sm uppercase tracking-[0.2em] text-gray-500">
            Direct visit
          </div>
          <h1 className="text-3xl font-semibold text-white">{product.name}</h1>
          <p className="max-w-xl text-sm leading-6 text-gray-400">
            Loading this URL directly should render the standalone page. Navigating
            from the gallery should keep the gallery visible and render this content
            in the parallel modal slot instead.
          </p>
          <div className="font-mono text-sm text-cyan-300">
            {`$${product.price.toFixed(2)}`}
          </div>
        </div>
      </div>
    </Boundary>
  );
}
