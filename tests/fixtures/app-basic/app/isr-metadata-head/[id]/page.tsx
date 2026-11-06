// An ISR page whose generateMetadata() resolves after the page, so its title
// is in <head> only when the render waits for it. Next.js renders an ISR page
// whole before serving it, so it does.
export const revalidate = 1;

export function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { title: `ISR metadata head ${id}` };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <p data-testid="isr-metadata-head">
      {id} <span data-testid="timestamp">{Date.now()}</span>
    </p>
  );
}
