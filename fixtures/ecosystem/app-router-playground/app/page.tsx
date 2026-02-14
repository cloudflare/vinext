import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { LinkStatus } from '#/ui/link-status';
import Link from 'next/link';

export default function Page() {
  const demos = db.demo.findMany();
  return (
    <Boundary
      label="Examples"
      animateRerendering={false}
      kind="solid"
      className="flex flex-col gap-9"
    >
      {demos.map((section) => {
        return (
          <div key={section.name} className="flex flex-col gap-3">
            <div className="font-mono text-xs font-semibold tracking-wider text-gray-700 uppercase">
              {section.name}
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {section.items.map((item) => {
                return (
                  <Link
                    href={`/${item.slug}`}
                    key={item.name}
                    className="group flex flex-col gap-1 rounded-lg bg-gray-900 px-5 py-3 hover:bg-gray-800"
                  >
                    <div className="flex items-center justify-between font-medium text-gray-200 group-hover:text-gray-50">
                      {item.name} <LinkStatus />
                    </div>

                    {item.description ? (
                      <div className="line-clamp-3 text-[13px] text-gray-500 group-hover:text-gray-300">
                        {item.description}
                      </div>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </Boundary>
  );
}
