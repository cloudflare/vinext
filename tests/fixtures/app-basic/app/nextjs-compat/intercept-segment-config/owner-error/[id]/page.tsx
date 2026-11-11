import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <p id="intercept-config-full">owner-error full {id}</p>
      <Link id="intercept-config-next" href="/nextjs-compat/intercept-segment-config/owner-error/2">
        Open 2
      </Link>
    </div>
  );
}
