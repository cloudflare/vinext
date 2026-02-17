import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Tab } from '#/ui/tabs';

export default function Page() {
  const demo = db.demo.find({ where: { slug: 'route-groups' } });

  return (
    <Boundary label="(checkout)/page.tsx" className="flex flex-col gap-9">
      <div className="flex">
        <Tab item={{ text: 'Back', slug: demo.slug }} />
      </div>
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-gray-300">Checkout</h1>

        <div className="flex flex-col gap-2">
          <div className="h-2 w-4/5 rounded-full bg-gray-800" />
          <div className="h-2 w-1/3 rounded-full bg-gray-800" />
        </div>
      </div>
    </Boundary>
  );
}
