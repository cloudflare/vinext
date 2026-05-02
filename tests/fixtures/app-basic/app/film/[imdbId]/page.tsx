export default function FilmPage({ params }: { params: { imdbId: string } }) {
  return (
    <main data-testid="detail-page">
      <h1>Film Detail</h1>
      <p data-testid="detail-page-id">{params.imdbId}</p>
    </main>
  );
}
