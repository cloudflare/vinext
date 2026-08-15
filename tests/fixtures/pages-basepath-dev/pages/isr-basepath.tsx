interface IsrBasePathProps {
  generation: number;
  generatedAt: number;
}

let generation = 0;

export default function IsrBasePath({ generation, generatedAt }: IsrBasePathProps) {
  return (
    <main>
      <h1>ISR BasePath</h1>
      <p data-testid="generation">{generation}</p>
      <p data-testid="generated-at">{generatedAt}</p>
    </main>
  );
}

export function getStaticProps() {
  return {
    props: { generation: ++generation, generatedAt: Date.now() },
    revalidate: 1,
  };
}
