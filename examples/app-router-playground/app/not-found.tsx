import { Boundary } from '#/ui/boundary';

export default function NotFound() {
  return (
    <Boundary label={['app/not-found.tsx']} color="pink">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-bold">Not Found</h2>
        <p className="text-sm">Could not find requested resource</p>
      </div>
    </Boundary>
  );
}
