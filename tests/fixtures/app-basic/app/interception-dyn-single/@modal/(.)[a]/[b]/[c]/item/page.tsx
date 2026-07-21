export default async function ItemModal({
  params,
}: {
  params: Promise<{ a: string; b: string; c: string }>;
}) {
  const { a, b, c } = await params;
  return (
    <div>
      Modal: Item for path {a}/{b}/{c}
    </div>
  );
}
