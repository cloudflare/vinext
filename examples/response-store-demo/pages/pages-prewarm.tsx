export async function getStaticProps(context: { draftMode?: boolean }) {
  return { props: { draftMode: context.draftMode === true }, revalidate: 300 };
}

export default function PagesPrewarmTarget({ draftMode }: { draftMode: boolean }) {
  return (
    <main>
      <output data-testid="draft-mode">{String(draftMode)}</output>
      <h1>Pages prewarm target</h1>
    </main>
  );
}
