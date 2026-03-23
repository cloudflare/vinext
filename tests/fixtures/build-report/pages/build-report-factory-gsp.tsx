function createGSP() {
  return async function generatedGetStaticProps() {
    return { props: {}, revalidate: 60 };
  };
}

export const getStaticProps = createGSP();

export default function Page() {
  return null;
}
