export default function ParallelPhotoModal({ params }: { params: { id: string } }) {
  return <p data-testid="parallel-photo-modal">Photo MODAL {params.id}</p>;
}
