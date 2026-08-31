export const revalidate = 300;

export default function PrewarmTargetPage() {
  return (
    <main>
      <output data-testid="build-id">{process.env.__VINEXT_BUILD_ID}</output>
      <h1>Prewarm target</h1>
    </main>
  );
}
