export default function BeforeInteractiveHeadOrderingPage(): React.ReactElement {
  return (
    <main>
      <h1>beforeInteractive head ordering</h1>
      <p>
        This page exists so the test suite can verify that an inline{" "}
        <code>{'<Script strategy="beforeInteractive">'}</code> in the layout&apos;s head is emitted
        before stylesheets and modulepreload links.
      </p>
    </main>
  );
}
