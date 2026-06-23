interface IsrBasePathProps {
  generatedAt: number;
}

export default function IsrBasePath({ generatedAt }: IsrBasePathProps) {
  return (
    <main>
      <h1>ISR BasePath</h1>
      <p data-testid="generated-at">{generatedAt}</p>
    </main>
  );
}

export function getStaticProps() {
  return {
    props: { generatedAt: Date.now() },
    revalidate: 1,
  };
}
