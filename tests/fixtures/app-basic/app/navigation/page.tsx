export default function Page() {
  return (
    <>
      <h1 id="render-id">{Math.random().toString(36).slice(2)}</h1>
      <h2 id="from-navigation">hello from /navigation</h2>
    </>
  );
}
