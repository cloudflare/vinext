interface ISRPageProps {
  timestamp: number;
  message: string;
}

export default function ISRPage({ timestamp, message }: ISRPageProps) {
  return (
    <div>
      <h1>ISR Page</h1>
      <p data-testid="message">{message}</p>
      <p data-testid="timestamp">{timestamp}</p>
    </div>
  );
}

export async function getStaticProps() {
  return {
    props: {
      timestamp: Date.now(),
      message: "Hello from ISR",
    },
    revalidate: 1, // Revalidate every 1 second
  };
}
