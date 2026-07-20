interface ISRPageProps {
  generation: number;
  timestamp: number;
  message: string;
}

let generation = 0;

export default function ISRPage({ generation, timestamp, message }: ISRPageProps) {
  return (
    <div>
      <h1>ISR Page</h1>
      <p data-testid="message">{message}</p>
      <p data-testid="generation">{generation}</p>
      <p data-testid="timestamp">{timestamp}</p>
    </div>
  );
}

export async function getStaticProps() {
  return {
    props: {
      generation: ++generation,
      timestamp: Date.now(),
      message: "Hello from ISR",
    },
    revalidate: 1, // Revalidate every 1 second
  };
}
