export default function StyledJsxStaticPropsPage({ source }: { source: string }) {
  return (
    <main>
      <p data-testid="styled-jsx-static-data-source">{source}</p>
      <style jsx>{`
        p {
          color: rgb(4, 5, 6);
        }
      `}</style>
    </main>
  );
}

export function getStaticProps() {
  return {
    props: { source: "getStaticProps" },
    revalidate: 60,
  };
}
