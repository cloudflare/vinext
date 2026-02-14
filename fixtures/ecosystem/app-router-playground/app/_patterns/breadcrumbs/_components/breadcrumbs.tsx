import { ChevronRightIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { Fragment } from 'react';

export function Breadcrumbs({
  items,
}: {
  items: { text: string; href: string }[];
}) {
  return (
    <div className="flex gap-1.5 text-sm">
      {items.map((item, i) => {
        return (
          <Fragment key={item.href}>
            {i === 0 ? null : (
              <ChevronRightIcon className="w-4 text-gray-500" />
            )}

            <Link
              key={item.href}
              href={item.href}
              className="text-white capitalize hover:text-gray-500"
            >
              {item.text}
            </Link>
          </Fragment>
        );
      })}
    </div>
  );
}
