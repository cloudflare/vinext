import { Boundary } from '#/ui/boundary';

export default function Page() {
  return (
    <Boundary label="page.tsx" size="small" className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-gray-300">Channel analytics</h1>

      <div className="flex flex-col gap-2">
        <div className="h-2 w-4/5 rounded-full bg-gray-800" />
        <div className="h-2 w-1/3 rounded-full bg-gray-800" />
      </div>
    </Boundary>
  );
}
