import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Tab } from '#/ui/tabs';

export default function NotFound() {
  const demo = db.demo.find({ where: { slug: 'not-found' } });

  return (
    <Boundary label="[section]/not-found.tsx" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-bold text-gray-100">Not Found</h1>
        <div className="text-sm text-gray-400">
          Sorry, the requested resource could not be found
        </div>
      </div>

      <div className="flex">
        <Tab item={{ text: 'Home', slug: demo.slug }} />
      </div>
    </Boundary>
  );
}
