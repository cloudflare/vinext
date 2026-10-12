export default function HomePage() {
  return (
    <>
      <h1>vinext Static Assets cache</h1>
      <p>
        This page was prerendered during <code>vinext build</code> and packaged into Workers Static
        Assets. The Worker serves it through <code>staticAssetsAdapter()</code> as a cache hit.
      </p>
    </>
  );
}
