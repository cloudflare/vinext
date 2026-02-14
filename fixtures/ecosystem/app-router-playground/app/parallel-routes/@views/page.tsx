import { Boundary } from '#/ui/boundary';

export default function Page() {
  return (
    <Boundary
      label="@views/page.tsx"
      size="small"
      className="flex flex-col gap-4"
    >
      <h1 className="font-semibold text-gray-300">View stats</h1>

      <div className="flex flex-col gap-2">
        <div className="h-2 w-4/5 rounded-full bg-gray-800" />
        <div className="h-2 w-1/3 rounded-full bg-gray-800" />
      </div>
    </Boundary>
  );
}
