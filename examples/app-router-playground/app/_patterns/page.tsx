import { ExternalLink } from '#/ui/external-link';
import Link from 'next/link';

const items = [
  {
    name: 'Active links',
    slug: 'active-links',
    description: 'Update the style of the current active link',
  },
  {
    name: 'Breadcrumbs',
    slug: 'breadcrumbs',
    description: 'Shared server-side Breadcrumb UI using Parallel Routes',
  },
  {
    name: 'Updating URL search params',
    slug: 'search-params',
    description: 'Update searchParams using `useRouter` and `<Link>`',
  },
];

export default function Page() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-medium text-gray-300">Patterns</h1>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {items.map((item) => {
          return (
            <Link
              href={`/patterns/${item.slug}`}
              key={item.name}
              className="group block space-y-1.5 rounded-lg bg-gray-900 px-5 py-3 hover:bg-gray-800"
            >
              <div className="font-medium text-gray-200 group-hover:text-gray-50">
                {item.name}
              </div>

              {item.description ? (
                <div className="line-clamp-3 text-sm text-gray-400 group-hover:text-gray-300">
                  {item.description}
                </div>
              ) : null}
            </Link>
          );
        })}
      </div>

      <div className="flex gap-2">
        <ExternalLink href="https://github.com/vercel/next-app-router-playground/tree/main/app/patterns">
          Code
        </ExternalLink>
      </div>
    </div>
  );
}
