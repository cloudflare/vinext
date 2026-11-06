// The slug reaches a `<style>` child as raw text. Stale regeneration must keep
// it there even when it spells out the shell's own boundary markup.
export default function IsrStylePage({ slug, renderedAt }: { slug: string; renderedAt: string }) {
  return (
    <>
      <style>{`:root{--isr-style-slug:${JSON.stringify(slug)}}`}</style>
      <p id="isr-style-rendered-at">{renderedAt}</p>
    </>
  );
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return {
    props: { slug: params.slug, renderedAt: String(Date.now()) },
    revalidate: 1,
  };
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}
