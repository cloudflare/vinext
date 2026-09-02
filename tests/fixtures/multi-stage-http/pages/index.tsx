type Props = { renderToken: string };

export default function Home({ renderToken }: Props) {
  return <main data-render-token={renderToken}>HTTP stage render: {renderToken}</main>;
}

export function getStaticProps() {
  return {
    props: { renderToken: crypto.randomUUID() },
    revalidate: 60,
  };
}
