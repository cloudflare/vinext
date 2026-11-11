export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <p id="intercept-config-full">slot-owner-static full {id}</p>
    </div>
  );
}
