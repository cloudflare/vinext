export default function HomePage() {
  return (
    <main>
      <h1>Font Google Multiple Test</h1>
      <p>This page tests multiple Google Fonts (Geist + Geist_Mono).</p>
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
