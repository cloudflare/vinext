export default function ParallelPhotoPage({ params }: { params: { id: string } }) {
  return <p data-testid="parallel-photo-page">Photo PAGE {params.id}</p>;
}
