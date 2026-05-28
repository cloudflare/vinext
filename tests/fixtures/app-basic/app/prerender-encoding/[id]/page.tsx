export const dynamicParams = false;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;

  return (
    <main>
      <div data-testid="prerender-encoding-id">params.id is {id}</div>
    </main>
  );
}

export function generateStaticParams() {
  const id = "sticks & stones";

  return [{ id }];
}
