import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Tab } from '#/ui/tabs';

export default function Default() {
  const demo = db.demo.find({ where: { slug: 'parallel-routes' } });

  return (
    <Boundary
      label="@views/default.tsx"
      size="small"
      className="flex flex-col gap-4"
    >
      <h1 className="font-semibold text-gray-300">Default</h1>

      <div className="flex flex-col gap-2">
        <div className="h-2 w-4/5 rounded-full bg-gray-800" />
        <div className="h-2 w-1/3 rounded-full bg-gray-800" />
      </div>

      <div className="flex">
        <Tab item={{ text: 'Home', slug: demo.slug }} />
      </div>
    </Boundary>
  );
}
