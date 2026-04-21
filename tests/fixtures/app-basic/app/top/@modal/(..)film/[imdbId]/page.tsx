export default function FilmModal({ params }: { params: { imdbId: string } }) {
  return (
    <aside data-testid="film-panel">
      <h2>Film Modal</h2>
      <p data-testid="film-panel-id">{params.imdbId}</p>
    </aside>
  );
}
