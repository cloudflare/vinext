export default async function ItemPage({
  params,
}: {
  params: Promise<{ a: string; b: string; c: string }>;
}) {
  const { a, b, c } = await params;
  return (
    <div>
      Item for path: {a}/{b}/{c}
    </div>
  );
}
