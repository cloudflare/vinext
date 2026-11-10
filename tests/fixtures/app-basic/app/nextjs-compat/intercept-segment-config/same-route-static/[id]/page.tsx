import Link from "next/link";

export const dynamic = "force-static";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <p id="intercept-config-full">same-route-static full {id}</p>
      <Link
        id="intercept-config-next"
        href={`/nextjs-compat/intercept-segment-config/same-route-static/${Number(id) + 1}`}
      >
        Next
      </Link>
    </div>
  );
}
