// Full photo page — rendered on direct navigation to /photos/[id].
export default function PhotoPage({ params }: { params: { id: string } }) {
  return (
    <div data-testid="photo-page">
      <h1>Photo {params.id}</h1>
      <p>Full photo view for photo {params.id}</p>
    </div>
  );
}
