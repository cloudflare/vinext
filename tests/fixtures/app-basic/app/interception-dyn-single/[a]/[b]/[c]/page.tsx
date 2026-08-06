import Link from "next/link";

export default async function ConsecutivePage({
  params,
}: {
  params: Promise<{ a: string; b: string; c: string }>;
}) {
  const { a, b, c } = await params;
  return (
    <div>
      <div id="consecutive-page">
        Path: {a}/{b}/{c}
      </div>
      <Link href={`/interception-dyn-single/${a}/${b}/${c}/item`} id="item-link">
        View Item
      </Link>
    </div>
  );
}
