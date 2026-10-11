// Renders the same page every time, so a regeneration keeps its ETag.
export const revalidate = 1;

export default function StableEtagPage() {
  return (
    <main>
      <h1>Stable ETag</h1>
    </main>
  );
}
