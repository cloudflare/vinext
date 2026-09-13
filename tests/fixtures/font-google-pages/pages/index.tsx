export default function HomePage() {
  return (
    <main>
      <h1>Font Google Pages Test</h1>
      <p>This page tests next/font/google self-hosting in the Pages Router.</p>
      <section aria-label="Local font weight examples">
        <p data-local-font-weight="400" style={{ fontWeight: 400 }}>
          Regular local font text
        </p>
        <p data-local-font-weight="600" style={{ fontWeight: 600 }}>
          Semibold local font text
        </p>
        <p data-local-font-weight="700" style={{ fontWeight: 700 }}>
          Bold local font text
        </p>
      </section>
    </main>
  );
}
